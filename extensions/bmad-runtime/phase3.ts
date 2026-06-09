import * as fs from "node:fs";
import * as path from "node:path";
import type { ArtifactRegistryEntry, ArtifactStatus } from "./artifacts.js";
import { scanArtifactRegistry } from "./artifacts.js";
import { evaluateDiffApprovalPolicy, formatDiffApprovalPolicy, type DiffApprovalPolicy } from "./diff-approval.js";
import { loadPathConfig, toProjectRelative } from "./paths.js";
import { evaluateReadinessGate } from "./readiness.js";
import type { Phase3GateStatus, Phase3ResumeState, Phase3Step, RuntimeState } from "./state.js";

const PHASE3_WORKFLOWS = new Set([
  "bmad-create-architecture",
  "bmad-create-epics-and-stories",
  "bmad-check-implementation-readiness",
]);

const PHASE3_ARTIFACT_IDS = ["architecture", "epics", "readiness"] as const;

const VALID_ARTIFACT_STATUSES = new Set<ArtifactStatus>([
  "missing",
  "seed",
  "draft",
  "canonical",
  "validated",
  "blocked",
  "waived",
]);

export interface Phase3ValidationResult {
  ok: boolean;
  issues: string[];
  writeOccurred: false;
}

export interface Phase3AutomationPlan {
  workflowId: string;
  currentStep: Phase3Step;
  artifactPath: string;
  evidencePath: string;
  validationChecks: string[];
  completionGate: "blocked" | "ready" | "complete";
  diffApproval: DiffApprovalPolicy;
  prompt: string;
  writeOccurred: false;
}

function phase3ArtifactEntries(artifacts: ArtifactRegistryEntry[]): ArtifactRegistryEntry[] {
  return PHASE3_ARTIFACT_IDS
    .map((id) => artifacts.find((entry) => entry.id === id))
    .filter((entry): entry is ArtifactRegistryEntry => !!entry);
}

function entryStatus(entries: ArtifactRegistryEntry[], id: string): ArtifactStatus {
  return entries.find((entry) => entry.id === id)?.status ?? "missing";
}

function artifactRecord(entries: ArtifactRegistryEntry[], field: "path" | "status"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) out[entry.id] = entry[field];
  return out;
}

function statusBlocksProgress(status: ArtifactStatus): boolean {
  return status === "missing" || status === "seed" || status === "draft" || status === "blocked";
}

function statusIsReady(status: ArtifactStatus): boolean {
  return status === "canonical" || status === "validated" || status === "waived";
}

function workflowForStep(step: Phase3Step): string {
  if (step === "architecture") return "bmad-create-architecture";
  if (step === "epics-stories") return "bmad-create-epics-and-stories";
  return "bmad-check-implementation-readiness";
}

function resumeActionForStep(step: Phase3Step): string {
  if (step === "architecture") return "Run bmad-create-architecture and persist/validate the architecture artifact.";
  if (step === "epics-stories") return "Run bmad-create-epics-and-stories and validate epics/stories coverage against architecture.";
  if (step === "readiness") return "Run bmad-check-implementation-readiness and persist readiness evidence.";
  return "Transition to Phase 4 implementation from persisted readiness evidence.";
}

function artifactIdForStep(step: Phase3Step): "architecture" | "epics" | "readiness" {
  if (step === "architecture") return "architecture";
  if (step === "epics-stories") return "epics";
  return "readiness";
}

function evidenceNameForStep(step: Phase3Step): string {
  if (step === "architecture") return "phase-3-architecture-evidence.md";
  if (step === "epics-stories") return "phase-3-epics-stories-evidence.md";
  if (step === "readiness") return "phase-3-readiness-evidence.md";
  return "phase-3-ready-for-phase-4-evidence.md";
}

function phase3Step(entries: ArtifactRegistryEntry[], readinessMayStart: boolean): Phase3Step {
  if (statusBlocksProgress(entryStatus(entries, "architecture"))) return "architecture";
  if (statusBlocksProgress(entryStatus(entries, "epics"))) return "epics-stories";
  if (!readinessMayStart || statusBlocksProgress(entryStatus(entries, "readiness"))) return "readiness";
  return "ready-for-phase-4";
}

function gateStatus(entries: ArtifactRegistryEntry[], readinessDecision: string, blockers: string[]): Phase3GateStatus {
  if (readinessDecision === "pass") return "ready";
  if (readinessDecision === "waived") return "waived";
  if (blockers.length > 0 || entries.some((entry) => entry.status === "blocked")) return "blocked";
  if (entries.some((entry) => entry.status === "missing")) return "missing";
  return "in-progress";
}

function collectValidationReportPaths(cwd: string, planningArtifacts: string, readinessReportPath: string): string[] {
  const reports = new Set<string>([readinessReportPath]);
  if (!fs.existsSync(planningArtifacts)) return [...reports];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(planningArtifacts, { withFileTypes: true });
  } catch {
    return [...reports];
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name.toLowerCase();
    const ext = path.extname(name);
    if (![".md", ".html", ".json", ".yaml", ".yml", ".txt"].includes(ext)) continue;
    if (!name.includes("readiness") && !name.includes("validation")) continue;
    reports.add(toProjectRelative(cwd, path.join(planningArtifacts, entry.name)));
    if (reports.size >= 10) break;
  }
  return [...reports];
}

export function isPhase3ResumeApplicable(state: RuntimeState): boolean {
  return state.phase === "3-solutioning" || PHASE3_WORKFLOWS.has(state.currentWorkflow ?? "");
}

export function buildPhase3ResumeState(cwd: string, state: RuntimeState, now = new Date()): Phase3ResumeState {
  const cfg = loadPathConfig(cwd);
  const artifacts = scanArtifactRegistry(cfg);
  const entries = phase3ArtifactEntries(artifacts);
  const readiness = evaluateReadinessGate(cfg, artifacts);
  const currentStep = phase3Step(entries, readiness.implementationMayStart);
  const workflowId = PHASE3_WORKFLOWS.has(state.currentWorkflow ?? "")
    ? state.currentWorkflow!
    : workflowForStep(currentStep);
  const blockers = [
    ...readiness.blockers,
    ...entries
      .filter((entry) => entry.status === "blocked")
      .map((entry) => `${entry.label} is marked blocked at ${entry.path}.`),
  ];
  const waivers = [
    ...(readiness.waiver?.reason ? [readiness.waiver.reason] : []),
    ...entries
      .filter((entry) => entry.status === "waived")
      .map((entry) => `${entry.label} waiver detected at ${entry.path}.`),
  ];

  return {
    workflowId,
    currentStep,
    artifactPaths: artifactRecord(entries, "path"),
    artifactStatuses: artifactRecord(entries, "status"),
    validationReportPaths: collectValidationReportPaths(cwd, cfg.planning_artifacts, readiness.reportPath),
    gateStatus: gateStatus(entries, readiness.decision, blockers),
    blockers: blockers.slice(0, 12),
    waivers: waivers.slice(0, 12),
    autonomyPolicyApplied: state.autonomy.phase3And4Yolo === true && (state.phase === "3-solutioning" || state.mode === "autonomous"),
    updatedAt: now.toISOString(),
    resumeAction: resumeActionForStep(currentStep),
  };
}

export function attachPhase3ResumeState(cwd: string, state: RuntimeState, now = new Date()): RuntimeState {
  if (!isPhase3ResumeApplicable(state)) return state;
  return {
    ...state,
    phase3: buildPhase3ResumeState(cwd, state, now),
  };
}

export function validatePhase3ResumeState(_cwd: string, snapshot: Phase3ResumeState): Phase3ValidationResult {
  const issues: string[] = [];
  for (const id of PHASE3_ARTIFACT_IDS) {
    const artifactPath = snapshot.artifactPaths[id];
    const status = snapshot.artifactStatuses[id];
    if (!artifactPath) issues.push(`Phase 3 artifact path is missing for ${id}.`);
    if (!status) {
      issues.push(`Phase 3 artifact status is missing for ${id}.`);
    } else if (!VALID_ARTIFACT_STATUSES.has(status as ArtifactStatus)) {
      issues.push(`Phase 3 artifact status is not parseable for ${id}: ${status}.`);
    }
  }
  if (!snapshot.workflowId) issues.push("Phase 3 workflow id is missing.");
  if (!snapshot.resumeAction) issues.push("Phase 3 resume action is missing.");
  if (snapshot.currentStep === "ready-for-phase-4") {
    if (snapshot.gateStatus !== "ready" && snapshot.gateStatus !== "waived") {
      issues.push(`Phase 3 cannot be complete with gate status ${snapshot.gateStatus}.`);
    }
    for (const id of PHASE3_ARTIFACT_IDS) {
      const status = snapshot.artifactStatuses[id] as ArtifactStatus | undefined;
      if (!status || !statusIsReady(status)) issues.push(`Phase 3 cannot be complete while ${id} status is ${status ?? "missing"}.`);
    }
  }
  return {
    ok: issues.length === 0,
    issues,
    writeOccurred: false,
  };
}

function readArtifact(cwd: string, relPath: string | undefined): string {
  if (!relPath) return "";
  const file = path.isAbsolute(relPath) ? relPath : path.join(cwd, relPath);
  if (!fs.existsSync(file)) return "";
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function hasCoverageAndDependencies(text: string): boolean {
  return /\bFR\d+\b/i.test(text) && /\bNFR\d+\b/i.test(text) && /\bdepend(?:enc|enc)|depend[eê]ncias?/i.test(text);
}

export function validatePhase3ArtifactsForAutomation(cwd: string, snapshot: Phase3ResumeState): Phase3ValidationResult {
  const issues = [...validatePhase3ResumeState(cwd, snapshot).issues];
  const architecture = readArtifact(cwd, snapshot.artifactPaths.architecture);
  const epics = readArtifact(cwd, snapshot.artifactPaths.epics);
  const readiness = readArtifact(cwd, snapshot.artifactPaths.readiness);

  if (snapshot.currentStep !== "architecture" && !architecture) {
    issues.push("Architecture artifact must exist before epics/stories or readiness can complete.");
  }
  if ((snapshot.currentStep === "readiness" || snapshot.currentStep === "ready-for-phase-4") && !hasCoverageAndDependencies(epics)) {
    issues.push("Epics/stories artifact must include FR coverage, NFR coverage, and dependencies before readiness.");
  }
  if (snapshot.currentStep === "ready-for-phase-4") {
    if (!/readinessdecision:\s*"?(?:pass|waiv)/i.test(readiness)) {
      issues.push("Readiness evidence must include readinessDecision pass or waiver before Phase 4.");
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    writeOccurred: false,
  };
}

export function buildPhase3AutomationPlan(cwd: string, state: RuntimeState, now = new Date()): Phase3AutomationPlan {
  const cfg = loadPathConfig(cwd);
  const snapshot = buildPhase3ResumeState(cwd, state, now);
  const artifactId = artifactIdForStep(snapshot.currentStep);
  const artifactPath = snapshot.artifactPaths[artifactId] ?? toProjectRelative(cwd, path.join(cfg.planning_artifacts, `${artifactId}.md`));
  const evidencePath = toProjectRelative(cwd, path.join(cfg.output_folder, "evidence", evidenceNameForStep(snapshot.currentStep)));
  const validation = validatePhase3ArtifactsForAutomation(cwd, snapshot);
  const diffApproval = evaluateDiffApprovalPolicy(cwd);
  const artifactCompletionGate = snapshot.currentStep === "ready-for-phase-4"
    ? (validation.ok ? "complete" : "blocked")
    : validation.issues.length > 0 && snapshot.currentStep !== "architecture"
      ? "blocked"
      : "ready";
  const completionGate = diffApproval.blocking ? "blocked" : artifactCompletionGate;
  const validationChecks = [
    "artifact path exists or is created at the declared path",
    "artifact status is parseable: canonical, validated, waived, blocked, draft, seed, or missing",
    "write evidence in Project Workspace evidence folder",
    ...diffApproval.evidence.map((item) => `diff approval policy: ${item}`),
  ];
  if (snapshot.currentStep === "epics-stories" || snapshot.currentStep === "readiness" || snapshot.currentStep === "ready-for-phase-4") {
    validationChecks.push("epics/stories include FR coverage, NFR coverage, and dependencies");
  }
  if (snapshot.currentStep === "readiness" || snapshot.currentStep === "ready-for-phase-4") {
    validationChecks.push("readiness evidence includes readinessDecision pass, blocked, or waiver");
  }
  const executionLines = diffApproval.blocking
    ? ["Do not execute this workflow until diff approval blockers are resolved."]
    : [
        "Execute this workflow with compact agent-facing artifacts:",
        "1. Read only the minimum upstream artifacts needed for this step.",
        "2. Create or validate the declared artifact path.",
        "3. Record evidence with workflow id, artifact path, validation/check result, gate outcome, timestamp, and blockers/waivers.",
        "4. For epics/stories, include explicit FR coverage, NFR coverage, and dependencies.",
        "5. For readiness, include readinessDecision and do not permit Phase 4 unless decision is pass or scoped waiver.",
        "6. Do not paste long BMAD documentation; use concise markdown/state-machine structure for agent consumption.",
      ];
  const prompt = [
    `/skill:${snapshot.workflowId}`,
    "",
    `BMAD Phase 3 automation step: ${snapshot.currentStep}.`,
    `Artifact path: ${artifactPath}`,
    `Evidence path: ${evidencePath}`,
    `Gate status: ${snapshot.gateStatus}`,
    `Diff approval mode: ${diffApproval.mode}`,
    `Diff approval blocking: ${diffApproval.blocking ? "yes" : "no"}`,
    "",
    ...(diffApproval.blocking
      ? ["Stop before workflow execution because diff approval could require a mandatory prompt/modal:", ...diffApproval.blockers.map((item) => `- ${item}`), ""]
      : ["Diff approval evidence:", ...diffApproval.evidence.map((item) => `- ${item}`), ""]),
    ...executionLines,
  ].join("\n");

  return {
    workflowId: snapshot.workflowId,
    currentStep: snapshot.currentStep,
    artifactPath,
    evidencePath,
    validationChecks,
    completionGate,
    diffApproval,
    prompt,
    writeOccurred: false,
  };
}

export function validatePhase3ReadinessForPhase4(cwd: string, state: RuntimeState): Phase3ValidationResult {
  const snapshot = buildPhase3ResumeState(cwd, { ...state, phase: "3-solutioning" });
  const validation = validatePhase3ArtifactsForAutomation(cwd, snapshot);
  const issues = [...validation.issues];
  if (snapshot.currentStep !== "ready-for-phase-4") {
    issues.push(`Phase 4 is blocked until Phase 3 reaches ready-for-phase-4; current step is ${snapshot.currentStep}.`);
  }
  if (snapshot.gateStatus !== "ready" && snapshot.gateStatus !== "waived") {
    issues.push(`Phase 4 is blocked by readiness gate status ${snapshot.gateStatus}.`);
  }
  return {
    ok: issues.length === 0,
    issues,
    writeOccurred: false,
  };
}

export function formatPhase3AutomationPlan(plan: Phase3AutomationPlan): string {
  return [
    "## Phase 3 Automation Plan",
    "",
    `Workflow ID: ${plan.workflowId}`,
    `Current step: ${plan.currentStep}`,
    `Artifact path: ${plan.artifactPath}`,
    `Evidence path: ${plan.evidencePath}`,
    `Completion gate: ${plan.completionGate}`,
    `Diff approval mode: ${plan.diffApproval.mode}`,
    `Diff approval blocking: ${plan.diffApproval.blocking ? "yes" : "no"}`,
    `Write occurred: ${plan.writeOccurred}`,
    "",
    "Validation checks:",
    ...plan.validationChecks.map((check) => `- ${check}`),
    "",
    formatDiffApprovalPolicy(plan.diffApproval),
    "",
    "Prompt:",
    "```text",
    plan.prompt,
    "```",
  ].join("\n");
}

export function formatPhase3ResumeState(snapshot: Phase3ResumeState, validation = validatePhase3ResumeState("", snapshot)): string {
  const artifactLines = PHASE3_ARTIFACT_IDS.map((id) => {
    const artifactPath = snapshot.artifactPaths[id] ?? "-";
    const status = snapshot.artifactStatuses[id] ?? "missing";
    return `- [${status}] ${id}: ${artifactPath}`;
  });
  const lines = [
    "## Phase 3 Resume/Validate",
    "",
    `Workflow ID: ${snapshot.workflowId}`,
    `Current step: ${snapshot.currentStep}`,
    `Gate status: ${snapshot.gateStatus}`,
    `Autonomy policy applied: ${snapshot.autonomyPolicyApplied ? "yes" : "no"}`,
    `Updated at: ${snapshot.updatedAt}`,
    `Resume action: ${snapshot.resumeAction}`,
    `Validation: ${validation.ok ? "ok" : "blocked"}`,
    "",
    "Artifacts:",
    ...artifactLines,
    "",
    "Validation reports:",
    ...(snapshot.validationReportPaths.length > 0 ? snapshot.validationReportPaths.map((report) => `- ${report}`) : ["- none"]),
  ];
  if (snapshot.blockers.length > 0) {
    lines.push("", "Blockers:", ...snapshot.blockers.map((blocker) => `- ${blocker}`));
  }
  if (snapshot.waivers.length > 0) {
    lines.push("", "Waivers:", ...snapshot.waivers.map((waiver) => `- ${waiver}`));
  }
  if (!validation.ok) {
    lines.push("", "Validation issues:", ...validation.issues.map((issue) => `- ${issue}`));
  }
  return lines.join("\n");
}
