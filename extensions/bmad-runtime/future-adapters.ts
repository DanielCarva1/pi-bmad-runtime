export type FutureAdapterId = "codex" | "opencode" | "claude-code";
export type FutureAdapterSupportLevel = "future-feasibility-only";

export interface FutureAdapterBoundary {
  id: FutureAdapterId;
  displayName: string;
  supportLevel: FutureAdapterSupportLevel;
  v02Supported: false;
  inputs: string[];
  outputs: string[];
  artifactPaths: string[];
  gateEvents: string[];
  minimumCommandCapabilities: string[];
  responsibilities: string[];
  limitations: string[];
  prototypeSmokeCriteria: string[];
}

export interface FutureAdapterBoundaryFinding {
  severity: "ok" | "blocked";
  label: string;
  detail: string;
}

export const REQUIRED_FUTURE_ADAPTERS = ["codex", "opencode", "claude-code"] as const;

const REQUIRED_ARRAY_FIELDS = [
  "inputs",
  "outputs",
  "artifactPaths",
  "gateEvents",
  "minimumCommandCapabilities",
  "responsibilities",
  "limitations",
  "prototypeSmokeCriteria",
] as const satisfies ReadonlyArray<keyof FutureAdapterBoundary>;

const SHARED_INPUTS = [
  "BMAD project identity",
  "runtime state summary",
  "latest handoff excerpt",
  "canonical artifact paths",
  "sprint status and next gate",
];

const SHARED_OUTPUTS = [
  "updated handoff",
  "workflow or story evidence",
  "gate result",
  "changed files summary when implementation is in scope",
  "next safe action",
];

const SHARED_ARTIFACT_PATHS = [
  ".bmad-runtime/state.json",
  ".bmad-runtime/handoffs/latest-handoff.md",
  "_bmad-output/**/planning-artifacts/**",
  "_bmad-output/**/implementation-artifacts/**",
  "_bmad-output/**/evidence/**",
];

const SHARED_GATE_EVENTS = [
  "project identity resolved",
  "readiness evaluated",
  "story created",
  "dev evidence recorded",
  "code review completed",
  "done gate passed or blocked",
];

const SHARED_MINIMUM_COMMAND_CAPABILITIES = [
  "start or resume BMAD project",
  "show status and next gate",
  "run or request next workflow",
  "write compact handoff",
];

const SHARED_RESPONSIBILITIES = [
  "preserve BMAD core semantics",
  "read artifacts before acting",
  "persist evidence before done",
  "respect project/runtime/code boundaries",
  "stop for autonomy-contract blockers",
];

const SHARED_LIMITATIONS = [
  "not supported as a v0.2 runtime adapter",
  "no external adapter command is registered",
  "no guarantee of host tool parity",
  "must not replace Pi-native P0 behavior",
];

const SHARED_PROTOTYPE_SMOKE_CRITERIA = [
  "loads a project from state plus handoff without chat memory",
  "reports next gate from artifacts",
  "records evidence in project-owned artifacts",
  "does not mutate code when project identity is ambiguous",
  "does not require a separate automation command",
];

function boundary(id: FutureAdapterId, displayName: string, extraLimitations: string[]): FutureAdapterBoundary {
  return {
    id,
    displayName,
    supportLevel: "future-feasibility-only",
    v02Supported: false,
    inputs: SHARED_INPUTS,
    outputs: SHARED_OUTPUTS,
    artifactPaths: SHARED_ARTIFACT_PATHS,
    gateEvents: SHARED_GATE_EVENTS,
    minimumCommandCapabilities: SHARED_MINIMUM_COMMAND_CAPABILITIES,
    responsibilities: SHARED_RESPONSIBILITIES,
    limitations: [...SHARED_LIMITATIONS, ...extraLimitations],
    prototypeSmokeCriteria: SHARED_PROTOTYPE_SMOKE_CRITERIA,
  };
}

export const FUTURE_ADAPTER_BOUNDARIES: FutureAdapterBoundary[] = [
  boundary("codex", "Codex", [
    "thread/worktree coordination must be proven separately",
    "tool and approval semantics may differ from Pi",
  ]),
  boundary("opencode", "OpenCode", [
    "host command and session APIs must be mapped before implementation",
    "artifact persistence behavior is unverified",
  ]),
  boundary("claude-code", "Claude Code", [
    "slash-command and hook semantics must be mapped before implementation",
    "subagent or review delegation parity is unverified",
  ]),
];

function arrayFieldMissing(boundary: FutureAdapterBoundary, field: (typeof REQUIRED_ARRAY_FIELDS)[number]): boolean {
  const value = boundary[field];
  return !Array.isArray(value) || value.length === 0;
}

export function validateFutureAdapterBoundaries(boundaries = FUTURE_ADAPTER_BOUNDARIES): FutureAdapterBoundaryFinding[] {
  const findings: FutureAdapterBoundaryFinding[] = [];
  const ids = new Set(boundaries.map((item) => item.id));

  findings.push({
    severity: REQUIRED_FUTURE_ADAPTERS.every((id) => ids.has(id)) ? "ok" : "blocked",
    label: "future-adapter-targets",
    detail: `Required future targets: ${REQUIRED_FUTURE_ADAPTERS.join(", ")}`,
  });

  const unsupported = boundaries.every((item) => item.supportLevel === "future-feasibility-only" && item.v02Supported === false);
  findings.push({
    severity: unsupported ? "ok" : "blocked",
    label: "future-only-scope",
    detail: "All external adapters must remain future-feasibility-only and unsupported in v0.2.",
  });

  const missingFields = boundaries.flatMap((item) =>
    REQUIRED_ARRAY_FIELDS
      .filter((field) => arrayFieldMissing(item, field))
      .map((field) => `${item.id}.${field}`),
  );
  findings.push({
    severity: missingFields.length === 0 ? "ok" : "blocked",
    label: "required-boundary-fields",
    detail: missingFields.length ? `Missing fields: ${missingFields.join(", ")}` : "All future adapter boundary fields are populated.",
  });

  const p0Limitations = boundaries.every((item) => item.limitations.some((limitation) => limitation.toLowerCase().includes("pi-native p0")));
  findings.push({
    severity: p0Limitations ? "ok" : "blocked",
    label: "pi-native-p0-preserved",
    detail: "Every future adapter boundary must state that it does not replace Pi-native P0 behavior.",
  });

  return findings;
}
