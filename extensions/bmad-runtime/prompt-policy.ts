import type { RuntimeMode, RuntimePhase, RuntimeState } from "./state.js";

export type WorkflowFreshLaunchMode = "ask" | "always" | "never";

export type RoutinePromptActionKind =
  | "workflow-fresh-session"
  | "deterministic-validation"
  | "step-transition"
  | "conformance-fix";

export type HighRiskPromptActionKind =
  | "credentials"
  | "paid-service"
  | "destructive-action"
  | "deploy-publication"
  | "remote-write"
  | "waiver"
  | "scope-expansion"
  | "product-terminology-decision"
  | "baseline-or-reference-write";

export type PromptActionKind = RoutinePromptActionKind | HighRiskPromptActionKind;
export type PromptPolicyDecisionKind = "automatic" | "ask-user" | "owner-approval-required";
export type PromptPolicyCategory = "routine" | "high-risk";

export interface PromptPolicyState {
  phase: RuntimePhase | string;
  mode: RuntimeMode | string;
  autonomy?: Pick<RuntimeState["autonomy"], "phase3And4Yolo" | "askUserOnlyFor">;
}

export interface PromptPolicyInput {
  kind: PromptActionKind;
  state: PromptPolicyState;
  action?: string;
  command?: string;
}

export interface PromptPolicyDecision {
  kind: PromptActionKind;
  decision: PromptPolicyDecisionKind;
  category: PromptPolicyCategory;
  requiresOwnerApproval: boolean;
  reason: string;
  recovery: string;
  evidenceRequired: string[];
  writeOccurred: false;
}

export interface WorkflowLaunchPolicy {
  launchFresh: boolean;
  askForConfirmation: boolean;
  reason: string;
  recovery: string;
}

const ROUTINE_ACTIONS = new Set<PromptActionKind>([
  "workflow-fresh-session",
  "deterministic-validation",
  "step-transition",
  "conformance-fix",
]);

const HIGH_RISK_REASONS: Record<HighRiskPromptActionKind, string> = {
  credentials: "Credentials, secrets, tokens, passwords, or account access can expose private infrastructure.",
  "paid-service": "Paid services or billing operations can create cost or account commitments.",
  "destructive-action": "Destructive actions can remove local or remote data and may be irreversible.",
  "deploy-publication": "Deployments and publication change externally visible state.",
  "remote-write": "Remote writes affect repositories, registries, services, or accounts outside the active workspace.",
  waiver: "Waivers bypass an approved BMAD gate and require accountable human ownership.",
  "scope-expansion": "Scope expansion changes the approved PRD, architecture, or implementation envelope.",
  "product-terminology-decision": "Product, legal, compliance, or terminology decisions need human judgment.",
  "baseline-or-reference-write": "Baseline locks and reference projects are protected engine/project boundaries.",
};

const HIGH_RISK_EVIDENCE = [
  "Owner identity",
  "approved scope",
  "risk/impact note",
  "approval timestamp",
  "evidence artifact path",
];

export function isTechnicalAutonomousPhase(state: PromptPolicyState): boolean {
  const technicalPhase = state.phase === "3-solutioning" || state.phase === "4-implementation";
  return technicalPhase && (state.mode === "autonomous" || state.autonomy?.phase3And4Yolo !== false);
}

export function classifyPromptRequirement(input: PromptPolicyInput): PromptPolicyDecision {
  if (!ROUTINE_ACTIONS.has(input.kind)) {
    const reason = HIGH_RISK_REASONS[input.kind as HighRiskPromptActionKind];
    return {
      kind: input.kind,
      decision: "owner-approval-required",
      category: "high-risk",
      requiresOwnerApproval: true,
      reason,
      recovery: "Record explicit Owner approval with owner, scope, risk and evidence before retrying this action in a separately approved step.",
      evidenceRequired: HIGH_RISK_EVIDENCE,
      writeOccurred: false,
    };
  }

  if (isTechnicalAutonomousPhase(input.state)) {
    return {
      kind: input.kind,
      decision: "automatic",
      category: "routine",
      requiresOwnerApproval: false,
      reason: "Phase 3/4 autonomous work may advance deterministic workflow steps without mechanical confirmation.",
      recovery: "Continue the BMAD workflow and persist status/evidence when the workflow reaches a real gate.",
      evidenceRequired: ["workflow result", "status/evidence update when a BMAD gate changes"],
      writeOccurred: false,
    };
  }

  return {
    kind: input.kind,
    decision: "ask-user",
    category: "routine",
    requiresOwnerApproval: false,
    reason: "Human-in-loop BMAD phases can ask concise questions when user preference is part of the workflow.",
    recovery: "Ask one compact decision question and continue from the user's answer.",
    evidenceRequired: [],
    writeOccurred: false,
  };
}

export function decideWorkflowLaunchPolicy(
  state: PromptPolicyState,
  fresh: WorkflowFreshLaunchMode,
  canLaunchFresh: boolean,
  hasUI: boolean,
): WorkflowLaunchPolicy {
  if (fresh === "never") {
    return {
      launchFresh: false,
      askForConfirmation: false,
      reason: "Same-session launch was explicitly requested.",
      recovery: "Run the workflow in the current session.",
    };
  }

  if (!canLaunchFresh) {
    return {
      launchFresh: false,
      askForConfirmation: false,
      reason: "Fresh-session API is unavailable.",
      recovery: "Run the workflow in the current session and keep the runtime handoff compact.",
    };
  }

  if (fresh === "always") {
    return {
      launchFresh: true,
      askForConfirmation: false,
      reason: "Fresh-session launch was explicitly requested.",
      recovery: "Start the workflow in a fresh session.",
    };
  }

  const decision = classifyPromptRequirement({ kind: "workflow-fresh-session", state });
  if (decision.decision === "automatic") {
    return {
      launchFresh: true,
      askForConfirmation: false,
      reason: decision.reason,
      recovery: decision.recovery,
    };
  }

  return {
    launchFresh: false,
    askForConfirmation: hasUI,
    reason: decision.reason,
    recovery: decision.recovery,
  };
}

export function formatOwnerApprovalBlock(
  decision: PromptPolicyDecision,
  context: { action?: string; command?: string; toolName?: string } = {},
): string {
  return [
    "BMAD Runtime prompt policy blocked a high-risk action.",
    `Policy action: ${decision.kind}`,
    context.action ? `Action: ${context.action}` : undefined,
    context.command ? `Command: ${context.command}` : undefined,
    context.toolName ? `Tool: ${context.toolName}` : undefined,
    `Reason: ${decision.reason}`,
    "Owner approval required: scope, risk, owner and evidence must be recorded before retry.",
    `Evidence required: ${decision.evidenceRequired.join("; ")}`,
    `Recovery: ${decision.recovery}`,
    "writeOccurred: false",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function formatPromptPolicySummary(state: PromptPolicyState): string {
  const routine = classifyPromptRequirement({ kind: "step-transition", state });
  const ownerOnly = state.autonomy?.askUserOnlyFor?.length
    ? state.autonomy.askUserOnlyFor
    : Object.keys(HIGH_RISK_REASONS);
  return [
    "## Prompt Policy",
    "",
    `Routine Phase 3/4 steps: ${routine.decision === "automatic" ? "automatic; no mechanical confirmation" : "ask only when user preference is part of the workflow"}.`,
    "Owner approval required for:",
    ...ownerOnly.map((item) => `- ${item}`),
  ].join("\n");
}
