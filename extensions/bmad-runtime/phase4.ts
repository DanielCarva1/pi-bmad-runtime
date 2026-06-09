import * as fs from "node:fs";
import * as path from "node:path";
import { collectProjectOwnedArtifactReferences, validateProjectOwnedArtifactReferences } from "./evidence.js";
import { determineRecoveryPoint } from "./recovery.js";
import { loadPathConfig, toProjectRelative } from "./paths.js";
import { loadSprintStatus, validateSprintDocument, type SprintStatusDocument, type SprintStatusEntry } from "./sprint.js";
import { analyzeStory, validateStoryDone } from "./story.js";
import { getStateFile, type Phase4AcceptedRiskDecision, type Phase4CheckSummary, type Phase4Checkpoint, type Phase4FailurePolicy, type Phase4ResumeState, type RuntimeState } from "./state.js";

const DEFAULT_PHASE4_RETRY_LIMIT = 3;

const PHASE4_WORKFLOWS = new Set([
  "bmad-sprint-planning",
  "bmad-create-story",
  "bmad-dev-story",
  "bmad-code-review",
]);

const STORY_STATUSES = new Set(["backlog", "ready-for-dev", "in-progress", "review", "done"]);

export interface Phase4ValidationResult {
  ok: boolean;
  issues: string[];
  writeOccurred: false;
}

export interface Phase4RetryEventInput {
  reason: string;
  actor?: string;
  evidence?: string[];
  now?: Date;
}

export interface Phase4RetryAppendResult {
  text: string;
  retryCount: number;
  eventLine: string;
}

export interface Phase4FailurePolicyInput {
  cwd?: string;
  storyStatus: string;
  storyText: string;
  checks: Phase4CheckSummary[];
  reviewOutcome: Phase4ResumeState["reviewOutcome"];
  retryCount: number;
  completionEvidence?: string[];
  persistedCompletion?: {
    artifactPathExists: boolean;
    sprintStatusExists: boolean;
    sprintHasTimestamp: boolean;
    stateUpdatePersisted: boolean;
  };
  retryLimit?: number;
}

function sectionBody(text: string, headingPattern: RegExp): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start === -1) return "";
  const level = lines[start]?.match(/^(#+)\s/)?.[1]?.length ?? 2;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const heading = line.match(/^(#+)\s/);
    if (heading?.[1] && heading[1].length <= level) break;
    body.push(line);
  }
  return body.join("\n");
}

function normalizeStoryRef(ref: string | null | undefined): string | undefined {
  if (!ref) return undefined;
  const trimmed = ref.trim();
  const numeric = trimmed.match(/^(\d+)\.(\d+)$/);
  if (numeric?.[1] && numeric?.[2]) return `${numeric[1]}-${numeric[2]}-`;
  return trimmed;
}

function findStoryEntry(doc: SprintStatusDocument | undefined, ref: string | null | undefined): SprintStatusEntry | undefined {
  if (!doc) return undefined;
  const normalized = normalizeStoryRef(ref);
  if (!normalized) return undefined;
  return doc.entries.find((entry) => entry.kind === "story" && (entry.key === normalized || entry.key.startsWith(normalized)));
}

function storyFilePath(implementationArtifacts: string, storyId: string | undefined): string | undefined {
  return storyId ? path.join(implementationArtifacts, `${storyId}.md`) : undefined;
}

function readIfExists(file: string | undefined): string {
  if (!file || !fs.existsSync(file)) return "";
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function cleanListLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s*/, "")
    .replace(/^`|`$/g, "")
    .trim();
}

function changedFilesFromStory(text: string): string[] {
  const body = sectionBody(text, /^###\s+File List\s*$/i);
  if (!body.trim()) return [];
  return body
    .split(/\r?\n/)
    .map(cleanListLine)
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, 30);
}

function checksFromStory(text: string): Phase4CheckSummary[] {
  const body = sectionBody(text, /^###\s+Debug Log References\s*$/i);
  if (!body.trim()) return [];
  return body
    .split(/\r?\n/)
    .map(cleanListLine)
    .filter((line) => /(npm|vitest|typecheck|test|pack|smoke)/i.test(line))
    .map((line) => {
      const result: Phase4CheckSummary["result"] = /\b(pass|passed)\b/i.test(line) ? "pass" : /\b(fail|failed)\b/i.test(line) ? "fail" : "unknown";
      const command = line.split(/\s+-\s+/)[0]?.trim() || line;
      return { command, result, evidence: line };
    })
    .slice(0, 20);
}

function reviewOutcome(text: string, storyStatus: string): Phase4ResumeState["reviewOutcome"] {
  if (!text) return "missing";
  const analysis = analyzeStory(text);
  const findings = classifiedReviewFindings(text);
  if (findings.some((finding) => finding.classification === "patch-required" || finding.classification === "decision-needed")) return "findings";
  if (analysis.hasApprovedReview) return "approved";
  if (analysis.unresolvedReviewFindingCount > 0) return "findings";
  if (analysis.hasSeniorDeveloperReview || storyStatus === "review") return "pending";
  return "not-started";
}

export function countPhase4RetryEvents(text: string): number {
  return text
    .split(/\r?\n/)
    .filter((line) => /\b(retry attempt|retry-count|retryCount|reopened at|reopen event)\b/i.test(line))
    .length;
}

function retryCount(text: string): number {
  return countPhase4RetryEvents(text);
}

function ensureRetryHistorySection(text: string): string {
  return /^##\s+Retry History\s*$/im.test(text)
    ? text.trimEnd()
    : `${text.trimEnd()}\n\n## Retry History\n`;
}

function cleanRetryField(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/[|;]/g, ",").trim();
}

export function appendPhase4RetryEvent(storyText: string, input: Phase4RetryEventInput): Phase4RetryAppendResult {
  const nextRetryCount = countPhase4RetryEvents(storyText) + 1;
  const timestamp = (input.now ?? new Date()).toISOString();
  const actor = cleanRetryField(input.actor ?? "BMAD Runtime");
  const reason = cleanRetryField(input.reason);
  const evidence = (input.evidence ?? [])
    .map(cleanRetryField)
    .filter(Boolean)
    .join(", ");
  const eventLine = `- retry attempt ${nextRetryCount}; reopened at: ${timestamp}; actor: ${actor}; reason: ${reason}${evidence ? `; evidence: ${evidence}` : ""}`;
  const withSection = ensureRetryHistorySection(storyText);
  return {
    text: `${withSection}\n${eventLine}\n`,
    retryCount: nextRetryCount,
    eventLine,
  };
}

function classifiedReviewFindings(text: string): { classification: "patch-required" | "decision-needed" | "accepted-risk" | "no-action"; detail: string }[] {
  const findings: { classification: "patch-required" | "decision-needed" | "accepted-risk" | "no-action"; detail: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(?:[-*]\s*)?\[?(patch-required|decision-needed|accepted-risk|no-action)\]?\s*(?:[:|-]\s*|\s+)(.+)$/i);
    if (!match?.[1] || !match?.[2]) continue;
    findings.push({ classification: match[1].toLowerCase() as "patch-required" | "decision-needed" | "accepted-risk" | "no-action", detail: match[2].trim() });
  }
  return findings;
}

function fieldValue(block: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`${escaped}\\s*[:=]\\s*([^;\\n]+)`, "i"));
  return match?.[1]?.trim();
}

function extractAcceptedRiskDecision(text: string): Phase4AcceptedRiskDecision | undefined {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!/\baccepted[- ]risk\b/i.test(line)) continue;
    const block = lines.slice(index, index + 5).join("\n");
    const owner = fieldValue(block, "owner");
    const scope = fieldValue(block, "scope");
    const evidenceText = fieldValue(block, "evidence");
    const evidence = evidenceText
      ?.split(/[,;]/)
      .map((item) => item.trim().replace(/^`|`$/g, ""))
      .filter(Boolean) ?? [];
    if (owner && scope && evidence.length > 0) return { owner, scope, evidence };
  }
  return undefined;
}

function completionEvidenceGaps(input: Phase4FailurePolicyInput): string[] {
  if (input.storyStatus !== "done" && input.storyStatus !== "complete") return [];
  const gaps: string[] = [];
  if (!input.checks.some((check) => check.result === "pass")) gaps.push("No passing check evidence recorded for done story.");
  if (input.reviewOutcome !== "approved") gaps.push(`Review outcome is ${input.reviewOutcome}, not approved.`);
  if ((input.completionEvidence ?? []).length === 0) gaps.push("No completion evidence recorded for done story.");
  if (input.persistedCompletion) {
    if (!input.persistedCompletion.artifactPathExists) gaps.push("No persisted story artifact path exists for done story.");
    if (!input.persistedCompletion.sprintStatusExists) gaps.push("No persisted sprint-status update exists for done story.");
    if (!input.persistedCompletion.sprintHasTimestamp) gaps.push("No persisted sprint/status timestamp recorded for done story.");
    if (!input.persistedCompletion.stateUpdatePersisted) gaps.push("No persisted runtime state update recorded for done story.");
  }
  if (input.cwd) {
    const refs = collectProjectOwnedArtifactReferences(input.storyText);
    const validation = validateProjectOwnedArtifactReferences(input.cwd, refs);
    for (const ref of validation.missing) gaps.push(`Project-owned artifact/evidence path does not exist: ${ref}.`);
    for (const ref of validation.outsideProject) gaps.push(`Project-owned artifact/evidence path is outside the Project Workspace: ${ref}.`);
    for (const ref of validation.unsupportedFormat) gaps.push(`Project-owned artifact/evidence path must be Markdown, YAML, or JSON: ${ref}.`);
  }
  return gaps;
}

export function classifyPhase4Failure(input: Phase4FailurePolicyInput): Phase4FailurePolicy {
  const retryLimit = input.retryLimit ?? DEFAULT_PHASE4_RETRY_LIMIT;
  const retryRemaining = Math.max(0, retryLimit - input.retryCount);
  const findings = classifiedReviewFindings(input.storyText);
  const patchFindings = findings.filter((finding) => finding.classification === "patch-required");
  const decisionFindings = findings.filter((finding) => finding.classification === "decision-needed");
  const acceptedRiskFindings = findings.filter((finding) => finding.classification === "accepted-risk");
  const acceptedRisk = extractAcceptedRiskDecision(input.storyText);
  const failedChecks = input.checks.filter((check) => check.result === "fail");
  const doneIssues = input.storyStatus === "done" ? validateStoryDone(input.storyText).map((issue) => issue.message) : [];
  const evidenceGaps = completionEvidenceGaps(input);

  const base = {
    retryLimit,
    retryRemaining,
    acceptedRisk,
  };

  if (decisionFindings.length > 0) {
    return {
      ...base,
      classification: "decision-needed",
      reasons: decisionFindings.map((finding) => finding.detail).slice(0, 20),
      retryTarget: null,
      retryScheduled: false,
    };
  }

  if (acceptedRiskFindings.length > 0 && !acceptedRisk) {
    return {
      ...base,
      classification: "accepted-risk-candidate",
      reasons: acceptedRiskFindings.map((finding) => `Accepted risk requires Owner, scope and evidence before completion: ${finding.detail}`).slice(0, 20),
      retryTarget: null,
      retryScheduled: false,
    };
  }

  const retryReasons = [
    ...failedChecks.map((check) => `Check failed: ${check.command}`),
    ...patchFindings.map((finding) => `Patch required: ${finding.detail}`),
    ...(input.reviewOutcome === "findings" ? ["Review outcome has unresolved findings."] : []),
    ...evidenceGaps,
    ...doneIssues,
  ];

  if (retryReasons.length > 0) {
    if (retryRemaining > 0) {
      return {
        ...base,
        classification: "retryable",
        reasons: retryReasons.slice(0, 20),
        retryTarget: "retry",
        retryScheduled: true,
      };
    }
    return {
      ...base,
      classification: "blocked",
      reasons: [`Retry limit ${retryLimit} reached.`, ...retryReasons].slice(0, 20),
      retryTarget: null,
      retryScheduled: false,
    };
  }

  return {
    ...base,
    classification: "none",
    reasons: [],
    retryTarget: null,
    retryScheduled: false,
  };
}

export function classifyPhase4FailureFromStory(storyStatus: string, storyText: string, completionEvidence: string[] = []): Phase4FailurePolicy {
  const checks = checksFromStory(storyText);
  return classifyPhase4Failure({
    storyStatus,
    storyText,
    checks,
    reviewOutcome: reviewOutcome(storyText, storyStatus),
    retryCount: retryCount(storyText),
    completionEvidence,
  });
}

function evidenceNeedle(storyId: string): string | undefined {
  const match = storyId.match(/^(\d+)-(\d+)-/);
  return match?.[1] && match?.[2] ? `story-${match[1]}-${match[2]}` : undefined;
}

function collectCompletionEvidence(cwd: string, outputFolder: string, storyId: string | undefined, storyRelPath: string | undefined, sprintDoc: SprintStatusDocument | undefined, sprintRelPath: string, checks: Phase4CheckSummary[], review: Phase4ResumeState["reviewOutcome"]): string[] {
  const evidence = new Set<string>();
  if (storyRelPath) evidence.add(storyRelPath);
  evidence.add(sprintRelPath);
  if (sprintDoc?.lastUpdatedLine) evidence.add("timestamp: sprint-status.last_updated");
  const statePath = getStateFile(cwd);
  if (fs.existsSync(statePath)) evidence.add(`state: ${toProjectRelative(cwd, statePath)}`);
  for (const check of checks.filter((item) => item.result === "pass")) evidence.add(`check: ${check.command}`);
  if (review === "approved" && storyRelPath) evidence.add(`approved-review: ${storyRelPath}`);
  const needle = storyId ? evidenceNeedle(storyId) : undefined;
  const evidenceDir = path.join(outputFolder, "evidence");
  if (needle && fs.existsSync(evidenceDir)) {
    try {
      for (const entry of fs.readdirSync(evidenceDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (entry.name.toLowerCase().includes(needle)) evidence.add(toProjectRelative(cwd, path.join(evidenceDir, entry.name)));
        if (evidence.size >= 30) break;
      }
    } catch {
      // Ignore unreadable evidence directories.
    }
  }
  return [...evidence].slice(0, 30);
}

function checkpointFor(storyStatus: string, storyText: string, changedFiles: string[], checks: Phase4CheckSummary[], review: Phase4ResumeState["reviewOutcome"], sprintDoc: SprintStatusDocument | undefined, failurePolicy: Phase4FailurePolicy): Phase4Checkpoint {
  if (!sprintDoc) return "blocked";
  if (failurePolicy.classification === "decision-needed" || failurePolicy.classification === "blocked" || failurePolicy.classification === "accepted-risk-candidate") return "blocked";
  if (failurePolicy.classification === "retryable" && storyStatus !== "backlog") return "retry";
  if (storyStatus === "backlog") return "create-story";
  if (storyStatus === "ready-for-dev") return "dev-story";
  if (storyStatus === "in-progress") return changedFiles.length > 0 && checks.length === 0 ? "run-checks" : "dev-story";
  if (storyStatus === "review") return review === "findings" ? "retry" : "code-review";
  if (storyStatus === "done") return storyText && validateStoryDone(storyText).length === 0 ? "complete" : "blocked";
  return "blocked";
}

function resumeActionFor(checkpoint: Phase4Checkpoint, storyId: string | undefined): string {
  const story = storyId ?? "the next story";
  if (checkpoint === "create-story") return `Create story context for ${story}, then run dev-story and code-review.`;
  if (checkpoint === "dev-story") return `Resume bmad-dev-story for ${story}.`;
  if (checkpoint === "run-checks") return `Rerun required checks for ${story}, then move to review when evidence is recorded.`;
  if (checkpoint === "code-review") return `Run bmad-code-review for ${story}.`;
  if (checkpoint === "retry") return `Patch review/check findings for ${story}, then rerun checks and review.`;
  if (checkpoint === "complete") return `Story ${story} is complete; continue to the next backlog story.`;
  return `Recover Phase 4 state for ${story}; inspect blocker reason before writing.`;
}

function blockerReason(storyStatus: string, storyText: string, storyRelPath: string | undefined, sprintDoc: SprintStatusDocument | undefined): string | undefined {
  if (!sprintDoc) return "Sprint status is missing or unreadable.";
  const sprintErrors = validateSprintDocument(sprintDoc).filter((issue) => issue.severity === "error");
  if (sprintErrors.length > 0) return sprintErrors.slice(0, 3).map((issue) => issue.message).join("; ");
  if (storyStatus !== "backlog" && !storyRelPath) return "Story file is missing for active Phase 4 story.";
  if (storyStatus === "done" && storyText) {
    const doneIssues = validateStoryDone(storyText);
    if (doneIssues.length > 0) return doneIssues.slice(0, 3).map((issue) => issue.message).join("; ");
  }
  return undefined;
}

function autonomyPolicyDecisions(state: RuntimeState): Record<string, string> {
  const enabled = state.autonomy.phase3And4Yolo === true || state.mode === "autonomous";
  return {
    commit: "external remote/push/publication requires Owner approval evidence",
    review: enabled ? "automatic Phase 4 review allowed" : "review requires runtime activation",
    retry: enabled ? "automatic retry allowed for patchable check/review failures" : "retry requires runtime activation",
    confirmation: "ask only for credentials, paid/destructive/external actions, contradictions, baseline changes or new scope",
  };
}

export function isPhase4ResumeApplicable(state: RuntimeState): boolean {
  return state.phase === "4-implementation" || PHASE4_WORKFLOWS.has(state.currentWorkflow ?? "");
}

export function buildPhase4ResumeState(cwd: string, state: RuntimeState, now = new Date()): Phase4ResumeState {
  const cfg = loadPathConfig(cwd);
  const sprint = loadSprintStatus(cfg);
  const recovery = determineRecoveryPoint(state, sprint.doc);
  const storyEntry =
    findStoryEntry(sprint.doc, recovery.currentStory) ??
    findStoryEntry(sprint.doc, state.currentStory) ??
    sprint.doc?.entries.find((entry) => entry.kind === "story" && ["review", "in-progress", "ready-for-dev", "backlog", "done"].includes(entry.status));
  const storyId = storyEntry?.key;
  const storyAbsPath = storyFilePath(cfg.implementation_artifacts, storyId);
  const storyText = readIfExists(storyAbsPath);
  const storyRelPath = storyAbsPath && fs.existsSync(storyAbsPath) ? toProjectRelative(cwd, storyAbsPath) : undefined;
  const storyStatus = storyEntry?.status ?? (recovery.status === "complete" ? "complete" : "unknown");
  const changedFiles = changedFilesFromStory(storyText);
  const checks = checksFromStory(storyText);
  const review = reviewOutcome(storyText, storyStatus);
  const sprintRelPath = toProjectRelative(cwd, sprint.path);
  const stateFile = getStateFile(cwd);
  const persistedCompletion = {
    artifactPathExists: !!storyRelPath,
    sprintStatusExists: sprint.exists,
    sprintHasTimestamp: !!sprint.doc?.lastUpdatedLine,
    stateUpdatePersisted: fs.existsSync(stateFile) && typeof state.updatedAt === "string" && state.updatedAt.trim().length > 0,
  };
  const completionEvidence = collectCompletionEvidence(cwd, cfg.output_folder, storyId, storyRelPath, sprint.doc, sprintRelPath, checks, review);
  const retry = retryCount(storyText);
  const failurePolicy = classifyPhase4Failure({
    cwd,
    storyStatus,
    storyText,
    checks,
    reviewOutcome: review,
    retryCount: retry,
    completionEvidence,
    persistedCompletion,
  });
  const checkpoint = checkpointFor(storyStatus, storyText, changedFiles, checks, review, sprint.doc, failurePolicy);
  const failureBlocker = failurePolicy.classification === "decision-needed" || failurePolicy.classification === "blocked" || failurePolicy.classification === "accepted-risk-candidate" || (storyStatus === "done" && failurePolicy.classification !== "none")
    ? failurePolicy.reasons.join("; ")
    : undefined;
  const blocker = blockerReason(storyStatus, storyText, storyRelPath, sprint.doc) ?? failureBlocker ?? (checkpoint === "blocked" ? recovery.message : undefined);

  return {
    storyId: storyId ?? null,
    storyStatus,
    currentWorkflow: state.currentWorkflow ?? recovery.currentWorkflow ?? null,
    checkpoint,
    sprintStatusPath: sprintRelPath,
    storyPath: storyRelPath,
    implementationStatus: recovery.status,
    changedFilesSummary: changedFiles,
    checks,
    reviewOutcome: review,
    retryCount: retry,
    failurePolicy,
    blockerReason: blocker,
    completionEvidence,
    autonomyPolicyDecisions: autonomyPolicyDecisions(state),
    updatedAt: now.toISOString(),
    resumeAction: resumeActionFor(checkpoint, storyId),
  };
}

export function attachPhase4ResumeState(cwd: string, state: RuntimeState, now = new Date()): RuntimeState {
  if (!isPhase4ResumeApplicable(state)) return state;
  return {
    ...state,
    phase4: buildPhase4ResumeState(cwd, state, now),
  };
}

export function validatePhase4ResumeState(_cwd: string, snapshot: Phase4ResumeState): Phase4ValidationResult {
  const issues: string[] = [];
  if (!snapshot.sprintStatusPath) issues.push("Phase 4 sprint status path is missing.");
  if (!snapshot.storyStatus || (snapshot.storyStatus !== "complete" && !STORY_STATUSES.has(snapshot.storyStatus))) {
    issues.push(`Phase 4 story status is not parseable: ${snapshot.storyStatus || "missing"}.`);
  }
  if (snapshot.storyStatus !== "backlog" && snapshot.storyStatus !== "complete" && !snapshot.storyPath) {
    issues.push("Phase 4 story path is missing for an active story.");
  }
  if (snapshot.storyStatus === "done" || snapshot.checkpoint === "complete") {
    if (snapshot.storyStatus !== "done") issues.push(`Phase 4 cannot be complete while story status is ${snapshot.storyStatus}.`);
    if (snapshot.reviewOutcome !== "approved") issues.push(`Phase 4 cannot be complete with review outcome ${snapshot.reviewOutcome}.`);
    if (snapshot.completionEvidence.length === 0) issues.push("Phase 4 cannot be complete without completion evidence.");
    if (!snapshot.checks.some((check) => check.result === "pass")) issues.push("Phase 4 cannot be complete without a passing check evidence entry.");
    if (snapshot.failurePolicy.classification !== "none") issues.push(`Phase 4 cannot be complete while failure policy is ${snapshot.failurePolicy.classification}.`);
  }
  if (snapshot.checkpoint === "blocked" && !snapshot.blockerReason) issues.push("Phase 4 blocked checkpoint is missing blocker reason.");
  if (snapshot.failurePolicy.classification === "accepted-risk-candidate") issues.push("Phase 4 accepted risk candidate is missing Owner approval, scope or evidence.");
  if (snapshot.failurePolicy.acceptedRisk) {
    if (!snapshot.failurePolicy.acceptedRisk.owner) issues.push("Phase 4 accepted risk is missing owner.");
    if (!snapshot.failurePolicy.acceptedRisk.scope) issues.push("Phase 4 accepted risk is missing scope.");
    if (snapshot.failurePolicy.acceptedRisk.evidence.length === 0) issues.push("Phase 4 accepted risk is missing evidence.");
  }
  return {
    ok: issues.length === 0,
    issues,
    writeOccurred: false,
  };
}

export function formatPhase4ResumeState(snapshot: Phase4ResumeState, validation = validatePhase4ResumeState("", snapshot)): string {
  const lines = [
    "## Phase 4 Resume/Validate",
    "",
    `Story ID: ${snapshot.storyId ?? "-"}`,
    `Story status: ${snapshot.storyStatus}`,
    `Current workflow: ${snapshot.currentWorkflow ?? "-"}`,
    `Checkpoint: ${snapshot.checkpoint}`,
    `Implementation status: ${snapshot.implementationStatus}`,
    `Review outcome: ${snapshot.reviewOutcome}`,
    `Retry count: ${snapshot.retryCount}`,
    `Failure policy: ${snapshot.failurePolicy.classification}`,
    `Retry scheduled: ${snapshot.failurePolicy.retryScheduled ? "yes" : "no"}`,
    `Retry remaining: ${snapshot.failurePolicy.retryRemaining}/${snapshot.failurePolicy.retryLimit}`,
    `Updated at: ${snapshot.updatedAt}`,
    `Resume action: ${snapshot.resumeAction}`,
    `Validation: ${validation.ok ? "ok" : "blocked"}`,
    "",
    `Sprint status: ${snapshot.sprintStatusPath}`,
    `Story path: ${snapshot.storyPath ?? "-"}`,
    "",
    "Changed files:",
    ...(snapshot.changedFilesSummary.length > 0 ? snapshot.changedFilesSummary.map((file) => `- ${file}`) : ["- none recorded"]),
    "",
    "Checks:",
    ...(snapshot.checks.length > 0 ? snapshot.checks.map((check) => `- [${check.result}] ${check.command}`) : ["- none recorded"]),
    "",
    "Completion evidence:",
    ...(snapshot.completionEvidence.length > 0 ? snapshot.completionEvidence.map((item) => `- ${item}`) : ["- none recorded"]),
  ];
  if (snapshot.failurePolicy.reasons.length > 0) lines.push("", "Failure reasons:", ...snapshot.failurePolicy.reasons.map((reason) => `- ${reason}`));
  if (snapshot.failurePolicy.acceptedRisk) {
    lines.push(
      "",
      "Accepted risk:",
      `- owner: ${snapshot.failurePolicy.acceptedRisk.owner}`,
      `- scope: ${snapshot.failurePolicy.acceptedRisk.scope}`,
      ...snapshot.failurePolicy.acceptedRisk.evidence.map((item) => `- evidence: ${item}`),
    );
  }
  if (snapshot.blockerReason) lines.push("", `Blocker reason: ${snapshot.blockerReason}`);
  lines.push("", "Autonomy policy decisions:", ...Object.entries(snapshot.autonomyPolicyDecisions).map(([key, value]) => `- ${key}: ${value}`));
  if (!validation.ok) lines.push("", "Validation issues:", ...validation.issues.map((issue) => `- ${issue}`));
  return lines.join("\n");
}
