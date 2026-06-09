import * as fs from "node:fs";
import * as path from "node:path";

export type RuntimePhase =
  | "0-init"
  | "1-analysis"
  | "2-planning"
  | "3-solutioning"
  | "4-implementation"
  | "5-ready-for-use"
  | "anytime";

export type RuntimeMode = "interview" | "autonomous" | "paused";

export type RuntimeTrack = "undecided" | "quick-flow" | "bmad-method" | "enterprise" | "custom";

export interface ParkingLotItem {
  text: string;
  createdAt: string;
}

export interface WorkflowRunRecord {
  skill: string;
  displayName?: string;
  menuCode?: string;
  phase: string;
  mode: RuntimeMode;
  launchedAt: string;
  launchArgs?: string;
}

export type Phase3Step = "architecture" | "epics-stories" | "readiness" | "ready-for-phase-4";
export type Phase3GateStatus = "missing" | "in-progress" | "blocked" | "ready" | "waived";

export interface Phase3ResumeState {
  workflowId: string;
  currentStep: Phase3Step;
  artifactPaths: Record<string, string>;
  artifactStatuses: Record<string, string>;
  validationReportPaths: string[];
  gateStatus: Phase3GateStatus;
  blockers: string[];
  waivers: string[];
  autonomyPolicyApplied: boolean;
  updatedAt: string;
  resumeAction: string;
}

export type Phase4Checkpoint =
  | "create-story"
  | "dev-story"
  | "run-checks"
  | "code-review"
  | "retry"
  | "blocked"
  | "complete";

export interface Phase4CheckSummary {
  command: string;
  result: "pass" | "fail" | "unknown";
  evidence: string;
}

export type Phase4FailureClassification =
  | "none"
  | "retryable"
  | "decision-needed"
  | "blocked"
  | "accepted-risk-candidate";

export interface Phase4AcceptedRiskDecision {
  owner: string;
  scope: string;
  evidence: string[];
}

export interface Phase4FailurePolicy {
  classification: Phase4FailureClassification;
  reasons: string[];
  retryTarget: Phase4Checkpoint | null;
  retryScheduled: boolean;
  retryLimit: number;
  retryRemaining: number;
  acceptedRisk?: Phase4AcceptedRiskDecision;
}

export interface Phase4ResumeState {
  storyId: string | null;
  storyStatus: string;
  currentWorkflow: string | null;
  checkpoint: Phase4Checkpoint;
  sprintStatusPath: string;
  storyPath?: string;
  implementationStatus: string;
  changedFilesSummary: string[];
  checks: Phase4CheckSummary[];
  reviewOutcome: "missing" | "not-started" | "pending" | "findings" | "approved";
  retryCount: number;
  failurePolicy: Phase4FailurePolicy;
  blockerReason?: string;
  completionEvidence: string[];
  autonomyPolicyDecisions: Record<string, string>;
  updatedAt: string;
  resumeAction: string;
}

export interface RuntimeState {
  version: 1;
  active: boolean;
  mode: RuntimeMode;
  track: RuntimeTrack;
  phase: RuntimePhase;
  currentWorkflow?: string | null;
  currentStory?: string | null;
  workflowHistory: WorkflowRunRecord[];
  autonomy: {
    phase3And4Yolo: boolean;
    askUserOnlyFor: string[];
  };
  createdAt: string;
  updatedAt: string;
  parkingLot: ParkingLotItem[];
  phase3?: Phase3ResumeState;
  phase4?: Phase4ResumeState;
}

export interface RuntimeStateSessionSummary {
  version: 1;
  active: boolean;
  mode: RuntimeMode;
  track: RuntimeTrack;
  phase: RuntimePhase;
  currentWorkflow?: string | null;
  currentStory?: string | null;
  workflowHistoryCount: number;
  lastRun?: WorkflowRunRecord | null;
  updatedAt: string;
}

export const STATE_DIR = ".bmad-runtime";
export const STATE_FILE = "state.json";
const MAX_WORKFLOW_HISTORY = 50;

export function getStateDir(cwd: string): string {
  return path.join(cwd, STATE_DIR);
}

export function getStateFile(cwd: string): string {
  return path.join(getStateDir(cwd), STATE_FILE);
}

export function createDefaultState(): RuntimeState {
  const now = new Date().toISOString();
  return {
    version: 1,
    active: false,
    mode: "interview",
    track: "undecided",
    phase: "0-init",
    currentWorkflow: null,
    currentStory: null,
    autonomy: {
      phase3And4Yolo: true,
      askUserOnlyFor: [
        "credentials, secrets, or account access",
        "paid external services or API usage not already configured",
        "destructive irreversible actions",
        "deploy, publication, remote writes, or externally visible service changes",
        "waivers for BMAD gates or accepted-risk decisions",
        "scope expansion outside approved PRD/architecture",
        "legal/compliance/product positioning or terminology decisions",
        "contradictions between approved artifacts",
        "active baseline lock changes or reference-project writes",
        "dependency installation if not pre-authorized by the project",
      ],
    },
    createdAt: now,
    updatedAt: now,
    parkingLot: [],
    workflowHistory: [],
  };
}

function normalizeState(raw: unknown): RuntimeState {
  const base = createDefaultState();
  if (!raw || typeof raw !== "object") return base;
  const value = raw as Partial<RuntimeState>;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : base.updatedAt;
  return {
    ...base,
    ...value,
    version: 1,
    autonomy: {
      ...base.autonomy,
      ...(value.autonomy ?? {}),
    },
    parkingLot: Array.isArray(value.parkingLot) ? value.parkingLot : [],
    workflowHistory: Array.isArray(value.workflowHistory)
      ? value.workflowHistory
        .map((entry) => normalizeWorkflowHistoryEntry(entry, updatedAt))
        .filter((entry): entry is WorkflowRunRecord => !!entry)
        .slice(-MAX_WORKFLOW_HISTORY)
      : [],
    phase3: normalizePhase3ResumeState(value.phase3, updatedAt),
    phase4: normalizePhase4ResumeState(value.phase4, updatedAt),
  };
}

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === "interview" || value === "autonomous" || value === "paused";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeWorkflowHistoryEntry(raw: unknown, fallbackTimestamp: string): WorkflowRunRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const skill = stringValue(value.skill) ?? stringValue(value.workflow);
  if (!skill) return undefined;
  const storyArg = stringValue(value.storyKey) ?? stringValue(value.story);
  return {
    skill,
    displayName: stringValue(value.displayName),
    menuCode: stringValue(value.menuCode),
    phase: stringValue(value.phase) ?? "anytime",
    mode: isRuntimeMode(value.mode) ? value.mode : "interview",
    launchedAt: stringValue(value.launchedAt) ?? stringValue(value.completedAt) ?? fallbackTimestamp,
    launchArgs: stringValue(value.launchArgs) ?? storyArg,
  };
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isPhase3Step(value: unknown): value is Phase3Step {
  return value === "architecture" || value === "epics-stories" || value === "readiness" || value === "ready-for-phase-4";
}

function isPhase3GateStatus(value: unknown): value is Phase3GateStatus {
  return value === "missing" || value === "in-progress" || value === "blocked" || value === "ready" || value === "waived";
}

function normalizePhase3ResumeState(value: unknown, fallbackTimestamp: string): Phase3ResumeState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const workflowId = stringValue(raw.workflowId);
  const resumeAction = stringValue(raw.resumeAction);
  if (!workflowId || !resumeAction) return undefined;
  return {
    workflowId,
    currentStep: isPhase3Step(raw.currentStep) ? raw.currentStep : "architecture",
    artifactPaths: normalizeStringRecord(raw.artifactPaths),
    artifactStatuses: normalizeStringRecord(raw.artifactStatuses),
    validationReportPaths: normalizeStringArray(raw.validationReportPaths),
    gateStatus: isPhase3GateStatus(raw.gateStatus) ? raw.gateStatus : "missing",
    blockers: normalizeStringArray(raw.blockers).slice(0, 12),
    waivers: normalizeStringArray(raw.waivers).slice(0, 12),
    autonomyPolicyApplied: raw.autonomyPolicyApplied === true,
    updatedAt: stringValue(raw.updatedAt) ?? fallbackTimestamp,
    resumeAction,
  };
}

function isPhase4Checkpoint(value: unknown): value is Phase4Checkpoint {
  return value === "create-story" || value === "dev-story" || value === "run-checks" || value === "code-review" || value === "retry" || value === "blocked" || value === "complete";
}

function isReviewOutcome(value: unknown): value is Phase4ResumeState["reviewOutcome"] {
  return value === "missing" || value === "not-started" || value === "pending" || value === "findings" || value === "approved";
}

function normalizePhase4Checks(value: unknown): Phase4CheckSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): Phase4CheckSummary | undefined => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
      const raw = item as Record<string, unknown>;
      const command = stringValue(raw.command);
      const evidence = stringValue(raw.evidence);
      if (!command || !evidence) return undefined;
      const result = raw.result === "pass" || raw.result === "fail" || raw.result === "unknown" ? raw.result : "unknown";
      return { command, result, evidence };
    })
    .filter((item): item is Phase4CheckSummary => !!item)
    .slice(0, 20);
}

function isPhase4FailureClassification(value: unknown): value is Phase4FailureClassification {
  return value === "none" || value === "retryable" || value === "decision-needed" || value === "blocked" || value === "accepted-risk-candidate";
}

function normalizeAcceptedRiskDecision(value: unknown): Phase4AcceptedRiskDecision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const owner = stringValue(raw.owner);
  const scope = stringValue(raw.scope);
  const evidence = normalizeStringArray(raw.evidence).slice(0, 20);
  if (!owner || !scope || evidence.length === 0) return undefined;
  return { owner, scope, evidence };
}

function normalizePhase4FailurePolicy(value: unknown): Phase4FailurePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { classification: "none", reasons: [], retryTarget: null, retryScheduled: false, retryLimit: 3, retryRemaining: 3 };
  }
  const raw = value as Record<string, unknown>;
  const retryLimit = typeof raw.retryLimit === "number" && Number.isFinite(raw.retryLimit) ? Math.max(0, Math.floor(raw.retryLimit)) : 3;
  const retryRemaining = typeof raw.retryRemaining === "number" && Number.isFinite(raw.retryRemaining) ? Math.max(0, Math.floor(raw.retryRemaining)) : retryLimit;
  return {
    classification: isPhase4FailureClassification(raw.classification) ? raw.classification : "none",
    reasons: normalizeStringArray(raw.reasons).slice(0, 20),
    retryTarget: isPhase4Checkpoint(raw.retryTarget) ? raw.retryTarget : null,
    retryScheduled: raw.retryScheduled === true,
    retryLimit,
    retryRemaining,
    acceptedRisk: normalizeAcceptedRiskDecision(raw.acceptedRisk),
  };
}

function normalizePhase4ResumeState(value: unknown, fallbackTimestamp: string): Phase4ResumeState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const sprintStatusPath = stringValue(raw.sprintStatusPath);
  const resumeAction = stringValue(raw.resumeAction);
  if (!sprintStatusPath || !resumeAction) return undefined;
  const storyId = stringValue(raw.storyId) ?? null;
  return {
    storyId,
    storyStatus: stringValue(raw.storyStatus) ?? "unknown",
    currentWorkflow: stringValue(raw.currentWorkflow) ?? null,
    checkpoint: isPhase4Checkpoint(raw.checkpoint) ? raw.checkpoint : "blocked",
    sprintStatusPath,
    storyPath: stringValue(raw.storyPath),
    implementationStatus: stringValue(raw.implementationStatus) ?? "unknown",
    changedFilesSummary: normalizeStringArray(raw.changedFilesSummary).slice(0, 30),
    checks: normalizePhase4Checks(raw.checks),
    reviewOutcome: isReviewOutcome(raw.reviewOutcome) ? raw.reviewOutcome : "missing",
    retryCount: typeof raw.retryCount === "number" && Number.isFinite(raw.retryCount) ? Math.max(0, Math.floor(raw.retryCount)) : 0,
    failurePolicy: normalizePhase4FailurePolicy(raw.failurePolicy),
    blockerReason: stringValue(raw.blockerReason),
    completionEvidence: normalizeStringArray(raw.completionEvidence).slice(0, 30),
    autonomyPolicyDecisions: normalizeStringRecord(raw.autonomyPolicyDecisions),
    updatedAt: stringValue(raw.updatedAt) ?? fallbackTimestamp,
    resumeAction,
  };
}

export function loadState(cwd: string): RuntimeState {
  const file = getStateFile(cwd);
  if (!fs.existsSync(file)) return createDefaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return normalizeState(parsed);
  } catch {
    return createDefaultState();
  }
}

export function saveState(cwd: string, state: RuntimeState): RuntimeState {
  const dir = getStateDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const next: RuntimeState = { ...state, updatedAt: new Date().toISOString() };
  fs.writeFileSync(getStateFile(cwd), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function activateState(state: RuntimeState): RuntimeState {
  return {
    ...state,
    active: true,
    mode: state.phase === "5-ready-for-use" ? "paused" : state.mode === "paused" ? "interview" : state.mode,
    phase: state.phase === "0-init" ? "1-analysis" : state.phase,
    currentWorkflow: state.phase === "5-ready-for-use" ? null : state.currentWorkflow,
    currentStory: state.phase === "5-ready-for-use" ? null : state.currentStory,
  };
}

export function deactivateState(state: RuntimeState): RuntimeState {
  return {
    ...state,
    active: false,
    mode: "paused",
    currentWorkflow: null,
  };
}

export function setPhase(state: RuntimeState, phase: RuntimePhase): RuntimeState {
  const mode: RuntimeMode = phase === "5-ready-for-use"
    ? "paused"
    : phase === "3-solutioning" || phase === "4-implementation"
      ? "autonomous"
      : "interview";
  return phase === "5-ready-for-use" ? { ...state, phase, mode, currentWorkflow: null, currentStory: null } : { ...state, phase, mode };
}

export function recordWorkflowLaunch(
  state: RuntimeState,
  run: Omit<WorkflowRunRecord, "mode" | "launchedAt"> & { mode?: RuntimeMode; launchedAt?: string },
): RuntimeState {
  const record: WorkflowRunRecord = {
    ...run,
    mode: run.mode ?? state.mode,
    launchedAt: run.launchedAt ?? new Date().toISOString(),
  };
  return {
    ...state,
    currentWorkflow: run.skill,
    workflowHistory: [...state.workflowHistory, record].slice(-MAX_WORKFLOW_HISTORY),
  };
}

export function isAutonomousPhase(state: RuntimeState): boolean {
  return !isReadyForUsePhase(state) && (state.phase === "3-solutioning" || state.phase === "4-implementation" || state.mode === "autonomous");
}

export function isReadyForUsePhase(state: RuntimeState): boolean {
  return state.phase === "5-ready-for-use";
}

export function summarizeStateForSession(state: RuntimeState): RuntimeStateSessionSummary {
  return {
    version: 1,
    active: state.active,
    mode: state.mode,
    track: state.track,
    phase: state.phase,
    currentWorkflow: state.currentWorkflow,
    currentStory: state.currentStory,
    workflowHistoryCount: state.workflowHistory.length,
    lastRun: state.workflowHistory.at(-1) ?? null,
    updatedAt: state.updatedAt,
  };
}
