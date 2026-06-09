export type BmadContractLayer = "core" | "runtime-agent-adapter" | "out-of-scope";

export interface BmadContractResponsibility {
  key: string;
  label: string;
  layer: BmadContractLayer;
  summary: string;
  examples: string[];
}

export interface BmadAdapterContract {
  name: string;
  piNativeP0: boolean;
  coreResponsibilities: BmadContractResponsibility[];
  adapterResponsibilities: BmadContractResponsibility[];
  outOfScopeResponsibilities: BmadContractResponsibility[];
}

export interface BmadAdapterContractFinding {
  severity: "ok" | "warning" | "blocked";
  label: string;
  detail: string;
}

export const REQUIRED_CORE_RESPONSIBILITIES = [
  "phase-model",
  "workflow-state",
  "artifacts",
  "gates",
  "evidence",
  "registry",
] as const;

export const REQUIRED_ADAPTER_RESPONSIBILITIES = [
  "command",
  "tool",
  "ui-prompt",
  "agent-execution",
] as const;

const CORE_API_FORBIDDEN_PATTERNS = [
  /\bpi\b/i,
  /\.pi\b/i,
  /\bregisterCommand\b/i,
  /\bsendMessage\b/i,
  /\bnewSession\b/i,
  /\bpackage settings\b/i,
  /\bslash command\b/i,
] as const;

export const BMAD_ADAPTER_CONTRACT: BmadAdapterContract = {
  name: "BMAD Core Semantics vs Runtime/Agent Adapter",
  piNativeP0: true,
  coreResponsibilities: [
    {
      key: "phase-model",
      label: "Phase model",
      layer: "core",
      summary: "Defines the BMAD phase sequence, phase names and legal phase transitions.",
      examples: ["1-analysis", "2-planning", "3-solutioning", "4-implementation", "5-ready-for-use"],
    },
    {
      key: "workflow-state",
      label: "Workflow state",
      layer: "core",
      summary: "Tracks current workflow, current step, current story and workflow completion state.",
      examples: ["currentWorkflow", "currentStory", "workflowHistory", "resumeAction"],
    },
    {
      key: "artifacts",
      label: "Artifacts",
      layer: "core",
      summary: "Defines canonical artifact categories and which artifact paths are source of truth.",
      examples: ["PRD", "architecture", "epics", "stories", "sprint status", "handoffs"],
    },
    {
      key: "gates",
      label: "Gates",
      layer: "core",
      summary: "Defines completion, readiness, safety, retry and done-gate rules.",
      examples: ["readiness pass", "blocked", "waived", "retryable", "done gate"],
    },
    {
      key: "evidence",
      label: "Evidence",
      layer: "core",
      summary: "Defines required evidence records for workflow, story, review and state transitions.",
      examples: ["check result", "review outcome", "state update path", "timestamp"],
    },
    {
      key: "registry",
      label: "Registry",
      layer: "core",
      summary: "Defines metadata-only project identity, aliases, roots, state path and schema version.",
      examples: ["projectId", "displayName", "knownRoots", "artifactRoot", "schemaVersion"],
    },
  ],
  adapterResponsibilities: [
    {
      key: "command",
      label: "Command surface",
      layer: "runtime-agent-adapter",
      summary: "Maps user entrypoints to BMAD runtime actions without changing BMAD semantics.",
      examples: ["/bmad-start", "/bmad start", "/bmad status", "/bmad resume"],
    },
    {
      key: "tool",
      label: "Tool boundary",
      layer: "runtime-agent-adapter",
      summary: "Integrates host tools, tool-call gates and local execution plumbing.",
      examples: ["tool_call gate", "read-only diagnostics", "bounded filesystem checks"],
    },
    {
      key: "ui-prompt",
      label: "UI and prompt boundary",
      layer: "runtime-agent-adapter",
      summary: "Formats pickers, status messages, hidden context and resume bootstrap prompts.",
      examples: ["project picker", "recovery hint", "hidden BMAD context", "handoff excerpt"],
    },
    {
      key: "agent-execution",
      label: "Agent execution",
      layer: "runtime-agent-adapter",
      summary: "Runs or asks the host agent to run BMAD workflows, reviews and subagent delegation.",
      examples: ["fresh session launch", "review delegation", "agent bootstrap", "workflow prompt"],
    },
  ],
  outOfScopeResponsibilities: [
    {
      key: "external-adapter-implementation",
      label: "External adapter implementation",
      layer: "out-of-scope",
      summary: "Future adapter support is feasibility work, not full v0.2 behavior.",
      examples: ["Codex adapter", "OpenCode adapter", "Claude Code adapter"],
    },
    {
      key: "fork-persona-model",
      label: "Fork or persona model",
      layer: "out-of-scope",
      summary: "The runtime does not create a separate named persona, fork method or non-BMAD route.",
      examples: ["method fork", "named persona", "non-BMAD planning track"],
    },
    {
      key: "separate-automation-command",
      label: "Separate automation command",
      layer: "out-of-scope",
      summary: "Phase 3/4 automation is runtime policy behind start and resume, not a public command.",
      examples: ["separate automation command", "manual automation mode"],
    },
  ],
};

function responsibilityText(responsibility: BmadContractResponsibility): string {
  return [
    responsibility.key,
    responsibility.label,
    responsibility.summary,
    ...responsibility.examples,
  ].join(" ");
}

function hasAllRequired(keys: Set<string>, required: readonly string[]): boolean {
  return required.every((key) => keys.has(key));
}

function coreHasForbiddenHostApi(contract: BmadAdapterContract): boolean {
  const text = contract.coreResponsibilities.map(responsibilityText).join("\n");
  return CORE_API_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(text));
}

export function validateBmadAdapterContract(contract = BMAD_ADAPTER_CONTRACT): BmadAdapterContractFinding[] {
  const findings: BmadAdapterContractFinding[] = [];
  const coreKeys = new Set(contract.coreResponsibilities.map((item) => item.key));
  const adapterKeys = new Set(contract.adapterResponsibilities.map((item) => item.key));

  findings.push({
    severity: hasAllRequired(coreKeys, REQUIRED_CORE_RESPONSIBILITIES) ? "ok" : "blocked",
    label: "core-responsibilities",
    detail: `Required core responsibilities: ${REQUIRED_CORE_RESPONSIBILITIES.join(", ")}`,
  });

  findings.push({
    severity: hasAllRequired(adapterKeys, REQUIRED_ADAPTER_RESPONSIBILITIES) ? "ok" : "blocked",
    label: "adapter-responsibilities",
    detail: `Required adapter responsibilities: ${REQUIRED_ADAPTER_RESPONSIBILITIES.join(", ")}`,
  });

  findings.push({
    severity: coreHasForbiddenHostApi(contract) ? "blocked" : "ok",
    label: "core-host-api-independence",
    detail: "BMAD core semantics must not mention host command, prompt, session or Pi API terms.",
  });

  findings.push({
    severity: contract.piNativeP0 ? "ok" : "blocked",
    label: "pi-native-p0",
    detail: "The active v0.2 implementation remains Pi-native while the core semantics stay portable.",
  });

  return findings;
}

export function classifyBmadResponsibility(text: string): BmadContractLayer {
  const normalized = text.toLowerCase();
  if (/\b(codex|opencode|claude code|method fork|named persona|non-bmad|separate automation command|public automation command|manual automation mode)\b/.test(normalized)) {
    return "out-of-scope";
  }
  if (/\b(command|slash|tool|ui|prompt|agent|session|subagent|package settings|\.pi)\b/.test(normalized)) {
    return "runtime-agent-adapter";
  }
  if (/\b(phase|workflow|artifact|gate|evidence|registry|story|sprint|readiness)\b/.test(normalized)) {
    return "core";
  }
  return "out-of-scope";
}
