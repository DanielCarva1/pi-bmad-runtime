import { formatPackageAdapters, scanPackageAdapters } from "./adapters.js";
import { formatArtifactCleanupPolicy, formatArtifactRegistry, scanArtifactRegistry } from "./artifacts.js";
import { buildPhase4AutomationContext, formatPhase4AutomationRecommendation, recommendPhase4Automation } from "./phase4-automation.js";
import { formatRuntimeBoundaries } from "./boundaries.js";
import { loadBmadCatalog } from "./catalog.js";
import { formatConfigValidation, validateRuntimeConfig } from "./config.js";
import { formatGrillClosureRecommendation, recommendGrillClosure } from "./grill.js";
import { formatLedgerSummary, summarizeLedger } from "./ledger.js";
import { loadPathConfig } from "./paths.js";
import { buildPhase3AutomationPlan, buildPhase3ResumeState, formatPhase3AutomationPlan, formatPhase3ResumeState, isPhase3ResumeApplicable, validatePhase3ResumeState, type Phase3AutomationPlan, type Phase3ValidationResult } from "./phase3.js";
import { buildPhase4ResumeState, formatPhase4ResumeState, isPhase4ResumeApplicable, validatePhase4ResumeState, type Phase4ValidationResult } from "./phase4.js";
import { formatPromptPolicySummary } from "./prompt-policy.js";
import type { RegistryOptions } from "./registry.js";
import { formatNameFirstProjectPicker, formatResolutionExplanation, resolveActiveProject, type ProjectResolutionResult } from "./resolution.js";
import { evaluateReadinessGate, formatGateCard, type ReadinessGateResult } from "./readiness.js";
import { recommendNext, summarizeCompletion, type Recommendation } from "./scanner.js";
import { loadSprintStatus, summarizeSprint, validateSprintDocument } from "./sprint.js";
import { scanStoryStatusFiles } from "./story.js";
import { isReadyForUsePhase, loadState, type RuntimeState } from "./state.js";
import { formatRecommendation, formatState } from "./ui.js";

export interface RuntimeStatusOptions {
  now?: () => number;
  slowThresholdMs?: number;
  registryOptions?: RegistryOptions;
}

export interface RuntimeStatusReport {
  state: RuntimeState;
  resolution: ProjectResolutionResult;
  readiness: ReadinessGateResult;
  phase3?: RuntimeState["phase3"];
  phase3Validation?: Phase3ValidationResult;
  phase3Plan?: Phase3AutomationPlan;
  phase4?: RuntimeState["phase4"];
  phase4Validation?: Phase4ValidationResult;
  recommendation: Recommendation;
  durationMs: number;
  slowThresholdMs: number;
  writeOccurred: boolean;
  text: string;
}

function sprintStatusLines(sprint: ReturnType<typeof loadSprintStatus>, cfg: ReturnType<typeof loadPathConfig>): string[] {
  const sprintStoryStatus = new Map(sprint.doc?.entries.filter((entry) => entry.kind === "story").map((entry) => [entry.key, entry.status]) ?? []);
  const storyFiles = scanStoryStatusFiles(cfg.implementation_artifacts);
  const storyMismatches = sprint.doc
    ? storyFiles.filter((story) => story.status && sprintStoryStatus.has(story.key) && sprintStoryStatus.get(story.key) !== story.status)
    : [];
  return sprint.doc
    ? [
        `Sprint status: ${sprint.path}`,
        `Sprint entries: ${sprint.doc.entries.length}`,
        `Sprint validation errors: ${validateSprintDocument(sprint.doc).filter((issue) => issue.severity === "error").length}`,
        `Sprint summary: ${JSON.stringify(summarizeSprint(sprint.doc))}`,
        `Story files detected: ${storyFiles.length}`,
        `Story/sprint status mismatches: ${storyMismatches.length}`,
        ...storyMismatches.slice(0, 5).map((story) => `Mismatch: ${story.key} story=${story.status} sprint=${sprintStoryStatus.get(story.key)}`),
      ]
    : [`Sprint status: ${sprint.exists ? `error: ${sprint.error}` : `not found at ${sprint.path}`}`];
}

function activeProjectLines(resolution: ProjectResolutionResult): string[] {
  const selected = resolution.selectedProject;
  const local = resolution.localWorkspace;
  const projectLine = selected
    ? `${selected.displayName} (${selected.projectId})`
    : local
      ? `${local.displayName} (${local.projectId}) — local workspace candidate, not active yet`
      : "unresolved";
  return [
    "## Active Project",
    "",
    `Project: ${projectLine}`,
    `Confidence: ${resolution.confidence}`,
    `Write occurred: ${resolution.writeOccurred}`,
    `Reason: ${resolution.reason}`,
    `Next safe action: ${resolution.nextSafeAction}`,
    "",
    "### Canonical Paths",
    "",
    `- Project Workspace: ${resolution.canonicalPaths.projectWorkspace}`,
    `- Output Folder: ${resolution.canonicalPaths.outputFolder}`,
    `- Runtime State: ${resolution.canonicalPaths.runtimeStatePath}`,
    `- Project Identity: ${resolution.canonicalPaths.projectIdentityPath}`,
    resolution.canonicalPaths.registryPath ? `- Registry: ${resolution.canonicalPaths.registryPath}` : "- Registry: default Runtime Home registry",
    "",
    formatResolutionExplanation(resolution),
    ...(resolution.confidence === "ambiguous" ? ["", formatNameFirstProjectPicker(resolution)] : []),
  ];
}

function stateExtraString(state: RuntimeState, key: string): string | undefined {
  const value = (state as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function lifecycleStatus(state: RuntimeState): string | undefined {
  const lifecycle = (state as unknown as { versionLifecycle?: Record<string, unknown> }).versionLifecycle;
  const status = lifecycle?.activeVersionStatus;
  return typeof status === "string" && status.trim() ? status : undefined;
}

function readinessState(readiness: ReadinessGateResult): string {
  if (readiness.decision === "pass") return "pass";
  if (readiness.decision === "waived") return "waived (exception)";
  if (readiness.decision === "missing") return "missing";
  return "blocked";
}

function nextStepSummary(state: RuntimeState, phase4Automation: ReturnType<typeof recommendPhase4Automation> | undefined, recommendation: Recommendation): string {
  if (isReadyForUsePhase(state)) return "ready-for-use: monitor, support, publish/install smoke, or start a new version/story explicitly";
  if (phase4Automation?.action === "complete") return "move-to-5-ready-for-use: Phase 4 story loop is complete";
  if (phase4Automation) return `${phase4Automation.action}: ${phase4Automation.reason}`;
  if (recommendation.row) return `${recommendation.row.skill}${recommendation.row.menuCode ? ` (${recommendation.row.menuCode})` : ""}`;
  return "none detected";
}

function operationalSummaryLines(state: RuntimeState, readiness: ReadinessGateResult, phase4Automation: ReturnType<typeof recommendPhase4Automation> | undefined, recommendation: Recommendation): string[] {
  const status = lifecycleStatus(state) ?? stateExtraString(state, "phase4Status") ?? stateExtraString(state, "readinessStatus") ?? "-";
  return [
    "## Operational Summary",
    "",
    `- Phase: ${state.phase}`,
    `- Status: ${status}`,
    `- Current workflow: ${state.currentWorkflow ?? "-"}`,
    `- Current story: ${state.currentStory ?? "-"}`,
    `- Next step: ${nextStepSummary(state, phase4Automation, recommendation)}`,
    `- Readiness decision: ${readiness.decision}`,
    `- Readiness state: ${readinessState(readiness)}`,
    `- Readiness blockers: ${readiness.blockers.length > 0 ? readiness.blockers.join("; ") : "none"}`,
    `- Readiness waiver: ${readiness.waiver?.reason ?? "none"}`,
  ];
}

export async function buildRuntimeStatusReport(cwd: string, options: RuntimeStatusOptions = {}): Promise<RuntimeStatusReport> {
  const now = options.now ?? Date.now;
  const started = now();
  const slowThresholdMs = options.slowThresholdMs ?? 2000;
  const state = loadState(cwd);
  const resolution = await resolveActiveProject(cwd, options.registryOptions ?? {});
  const catalog = loadBmadCatalog(cwd);
  const cfg = loadPathConfig(cwd);
  const recommendation = recommendNext(catalog.rows, cfg);
  const completion = summarizeCompletion(recommendation.completions);
  const artifacts = scanArtifactRegistry(cfg);
  const readiness = evaluateReadinessGate(cfg, artifacts);
  const phase3 = isPhase3ResumeApplicable(state) ? buildPhase3ResumeState(cwd, state) : undefined;
  const phase3Validation = phase3 ? validatePhase3ResumeState(cwd, phase3) : undefined;
  const phase3Plan = phase3 ? buildPhase3AutomationPlan(cwd, state) : undefined;
  const phase4 = isPhase4ResumeApplicable(state) ? buildPhase4ResumeState(cwd, state) : undefined;
  const phase4Validation = phase4 ? validatePhase4ResumeState(cwd, phase4) : undefined;
  const grillClosure = recommendGrillClosure(state, artifacts);
  const adapters = scanPackageAdapters(cwd);
  const configIssues = validateRuntimeConfig(cwd, cfg);
  const ledger = summarizeLedger(state, cfg);
  const sprint = loadSprintStatus(cfg);
  const phase4Automation = state.phase === "4-implementation" && sprint.doc ? recommendPhase4Automation(sprint.doc, cfg, buildPhase4AutomationContext(cwd, cfg)) : undefined;
  const durationMs = Math.max(0, now() - started);
  const nextStepText = phase4Automation ? formatPhase4AutomationRecommendation(phase4Automation) : formatRecommendation(recommendation);
  const text = [
    "# BMAD Runtime Status",
    "",
    `Status duration: ${durationMs}ms`,
    `Write occurred: ${resolution.writeOccurred}`,
    ...(durationMs > slowThresholdMs
      ? [`Performance note: status exceeded ${slowThresholdMs}ms while reading local artifacts/registry; writeOccurred=${resolution.writeOccurred}.`]
      : []),
    "",
    ...activeProjectLines(resolution),
    "",
    ...operationalSummaryLines(state, readiness, phase4Automation, recommendation),
    "",
    "## Runtime State",
    "",
    "```text",
    formatState(state),
    "```",
    "",
    formatPromptPolicySummary(state),
    "",
    `BMAD catalog: ${catalog.exists ? catalog.path : "not found"}`,
    catalog.error ? `Catalog error: ${catalog.error}` : `Catalog rows: ${catalog.rows.length}`,
    `Heuristic completion: ${completion.complete}/${completion.total}`,
    ...sprintStatusLines(sprint, cfg),
    "",
    formatArtifactRegistry(artifacts),
    "",
    formatArtifactCleanupPolicy(),
    "",
    formatRuntimeBoundaries(resolution.boundaries, cwd),
    "",
    formatGateCard(readiness),
    `Readiness blockers: ${readiness.blockers.length > 0 ? readiness.blockers.join("; ") : "none"}`,
    `Readiness waiver: ${readiness.waiver?.reason ?? "none"}`,
    "",
    ...(phase3 ? [formatPhase3ResumeState(phase3, phase3Validation), ""] : []),
    ...(phase3Plan ? [formatPhase3AutomationPlan(phase3Plan), ""] : []),
    ...(phase4 ? [formatPhase4ResumeState(phase4, phase4Validation), ""] : []),
    nextStepText,
    "",
    formatGrillClosureRecommendation(grillClosure),
    "",
    formatPackageAdapters(adapters),
    "",
    formatConfigValidation(configIssues),
    "",
    formatLedgerSummary(ledger),
  ].join("\n");
  return {
    state,
    resolution,
    readiness,
    phase3,
    phase3Validation,
    phase3Plan,
    phase4,
    phase4Validation,
    recommendation,
    durationMs,
    slowThresholdMs,
    writeOccurred: resolution.writeOccurred,
    text,
  };
}

export function formatRuntimeStatusReport(report: RuntimeStatusReport): string {
  return report.text;
}
