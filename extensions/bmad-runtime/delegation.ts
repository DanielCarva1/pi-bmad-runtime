import * as fs from "node:fs";
import * as path from "node:path";

export type DelegationMode = "real-subagents" | "degraded-same-session";
export type DelegationRunStatus = "spawned" | "degraded" | "blocked";

export interface DelegationContract {
  owner: string;
  role: string;
  objective: string;
  context: string[];
  allowedPaths: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
  riskLimits: string[];
  expectedOutput: string;
  stopCriteria: string[];
  maySubdelegate: boolean;
  evidencePath?: string;
}

export interface DelegationCapability {
  mode: DelegationMode;
  packageConfigured: boolean;
  serviceAvailable: boolean;
  detail: string;
}

export interface SubagentRecordLike {
  id: string;
  type: string;
  description: string;
  status: string;
  result?: string;
  error?: string;
}

export interface SubagentsServiceLike {
  spawn(type: string, prompt: string, options?: { description?: string; model?: string; maxTurns?: number; thinkingLevel?: string; isolated?: boolean; inheritContext?: boolean; foreground?: boolean; bypassQueue?: boolean; isolation?: "worktree" }): string;
  getRecord?(id: string): SubagentRecordLike | undefined;
  listAgents?(): SubagentRecordLike[];
  waitForAll?(): Promise<void>;
}

export interface DelegationRunOptions {
  cwd: string;
  service?: SubagentsServiceLike;
  agentType?: string;
  description?: string;
  maxTurns?: number;
  thinkingLevel?: string;
  inheritContext?: boolean;
  evidenceDir?: string;
}

export interface DelegationRunResult {
  status: DelegationRunStatus;
  mode: DelegationMode;
  independentExecution: boolean;
  contract: DelegationContract;
  issues: string[];
  prompt: string;
  detail: string;
  agentId?: string;
  evidencePath?: string;
}

const SERVICE_KEY = Symbol.for("@gotgenes/pi-subagents:service");

export function getPublishedSubagentsService(): SubagentsServiceLike | undefined {
  const service = (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
  if (!service || typeof service !== "object") return undefined;
  return typeof (service as Partial<SubagentsServiceLike>).spawn === "function" ? service as SubagentsServiceLike : undefined;
}

function packageSpecs(cwd: string): string[] {
  const settingsFile = path.join(cwd, ".pi", "settings.json");
  if (!fs.existsSync(settingsFile)) return [];
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as { packages?: unknown[] };
    return (settings.packages ?? []).map((entry) => typeof entry === "string" ? entry : entry && typeof entry === "object" ? String((entry as { source?: unknown }).source ?? "") : "").filter(Boolean);
  } catch {
    return [];
  }
}

export function detectDelegationCapability(cwd: string, service: SubagentsServiceLike | undefined = getPublishedSubagentsService()): DelegationCapability {
  const configured = packageSpecs(cwd).some((spec) => spec.includes("@gotgenes/pi-subagents") || spec.includes("pi-subagents"));
  const serviceAvailable = Boolean(service);
  if (configured && serviceAvailable) return { mode: "real-subagents", packageConfigured: true, serviceAvailable: true, detail: "Real Pi subagent package is configured and its runtime service is published." };
  if (configured) return { mode: "degraded-same-session", packageConfigured: true, serviceAvailable: false, detail: "Subagent package is configured but not loaded in this session; do not claim independent execution." };
  return { mode: "degraded-same-session", packageConfigured: false, serviceAvailable, detail: "Subagent package is not configured; use transparent same-session role simulation and label outputs degraded." };
}

export function createDelegationContract(input: Omit<DelegationContract, "maySubdelegate"> & { maySubdelegate?: boolean }): DelegationContract {
  return { ...input, maySubdelegate: input.maySubdelegate ?? false };
}

function compositeOwner(owner: string): boolean {
  return /[,;&+]|\band\b|\bwith\b/i.test(owner.trim());
}

export function validateDelegationContract(contract: DelegationContract): string[] {
  const issues: string[] = [];
  if (!contract.owner.trim()) issues.push("Delegation contract requires exactly one owner.");
  else if (compositeOwner(contract.owner)) issues.push("Delegation contract owner must be exactly one accountable owner, not a group.");
  if (!contract.role.trim()) issues.push("Delegation contract requires a role.");
  if (!contract.objective.trim()) issues.push("Delegation contract requires an objective.");
  if (contract.context.length === 0) issues.push("Delegation contract requires a bounded context packet.");
  if (contract.acceptanceCriteria.length === 0) issues.push("Delegation contract requires acceptance criteria.");
  if (contract.allowedPaths.length === 0) issues.push("Delegation contract requires allowed paths.");
  if (!contract.expectedOutput.trim()) issues.push("Delegation contract requires an expected output.");
  if (contract.stopCriteria.length === 0) issues.push("Delegation contract requires stop criteria.");
  if (contract.maySubdelegate) issues.push("Recursive subdelegation is disabled by default in v1 and requires explicit authorization.");
  return issues;
}

export function buildDelegationPrompt(contract: DelegationContract): string {
  const lines = [
    `You are acting as BMAD specialist role: ${contract.role}.`, "", "Delegation contract:",
    `- Owner: ${contract.owner}`, `- Objective: ${contract.objective}`, "- Allowed paths:",
    ...contract.allowedPaths.map((item) => `  - ${item}`), "- Acceptance criteria:",
    ...contract.acceptanceCriteria.map((item) => `  - ${item}`), "- Dependencies:",
    ...(contract.dependencies.length ? contract.dependencies.map((item) => `  - ${item}`) : ["  - none"]), "- Risk limits:",
    ...contract.riskLimits.map((item) => `  - ${item}`), "- Stop criteria:",
    ...contract.stopCriteria.map((item) => `  - ${item}`), `- Expected output: ${contract.expectedOutput}`,
    `- Subdelegation: ${contract.maySubdelegate ? "explicitly allowed" : "blocked; do not spawn subagents or expand scope"}`, "", "Bounded context packet:",
    ...contract.context.map((item) => `- ${item}`), "", "Return findings/decisions, files inspected or changed, AC coverage, tests/evidence, and unresolved blockers.",
  ];
  return lines.join("\n");
}

export function formatDelegationContract(contract: DelegationContract, capability: DelegationCapability): string {
  return [
    "Delegation contract", `Mode: ${capability.mode}`, `Real service available: ${capability.serviceAvailable ? "yes" : "no"}`,
    `Owner: ${contract.owner}`, `Role: ${contract.role}`, `Objective: ${contract.objective}`, "Context packet:",
    ...contract.context.map((item) => `- ${item}`), "Allowed paths:", ...contract.allowedPaths.map((item) => `- ${item}`),
    "Acceptance criteria:", ...contract.acceptanceCriteria.map((item) => `- ${item}`), "Risk limits:", ...contract.riskLimits.map((item) => `- ${item}`),
    "Stop criteria:", ...contract.stopCriteria.map((item) => `- ${item}`), `Expected output: ${contract.expectedOutput}`,
    `Subdelegation: ${contract.maySubdelegate ? "explicitly allowed" : "blocked by default"}`,
  ].join("\n");
}

export function runDelegationContract(contract: DelegationContract, options: DelegationRunOptions): DelegationRunResult {
  const issues = validateDelegationContract(contract);
  const service = options.service ?? getPublishedSubagentsService();
  const capability = detectDelegationCapability(options.cwd, service);
  const prompt = buildDelegationPrompt(contract);
  if (issues.length) {
    return { status: "blocked", mode: capability.mode, independentExecution: false, contract, issues, prompt, detail: "Delegation contract failed validation; no agent was spawned." };
  }
  if (capability.mode === "real-subagents" && service) {
    const agentId = service.spawn(options.agentType ?? contract.role, prompt, {
      description: options.description ?? contract.objective.slice(0, 48),
      maxTurns: options.maxTurns,
      thinkingLevel: options.thinkingLevel,
      inheritContext: options.inheritContext ?? false,
      foreground: false,
    });
    return { status: "spawned", mode: "real-subagents", independentExecution: true, contract, issues: [], agentId, prompt, detail: `Spawned real Pi subagent ${agentId} for role ${contract.role}.` };
  }
  return { status: "degraded", mode: "degraded-same-session", independentExecution: false, contract, issues: [], prompt, detail: `${capability.detail} Use the generated prompt in the current session and label output as degraded.` };
}

export function writeDelegationEvidence(cwd: string, result: DelegationRunResult, evidenceDir?: string): string {
  const dir = evidenceDir ?? path.join(cwd, "_bmad-output", "evidence", "delegations");
  fs.mkdirSync(dir, { recursive: true });
  const slug = result.contract.objective.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "delegation";
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}.md`);
  const lines = [
    "# BMAD Delegation Evidence",
    "",
    `- Status: ${result.status}`,
    `- Mode: ${result.mode}`,
    `- Independent execution: ${result.independentExecution ? "yes" : "no"}`,
    result.agentId ? `- Agent id: ${result.agentId}` : undefined,
    `- Detail: ${result.detail}`,
    "",
    "## Contract",
    "",
    formatDelegationContract(result.contract, { mode: result.mode, packageConfigured: result.mode === "real-subagents", serviceAvailable: result.independentExecution, detail: result.detail }),
    "",
    "## Prompt",
    "",
    "```text",
    result.prompt,
    "```",
    "",
    result.issues.length ? ["## Issues", "", ...result.issues.map((issue) => `- ${issue}`), ""].join("\n") : undefined,
  ];
  fs.writeFileSync(file, lines.filter((line): line is string => line !== undefined).join("\n"), "utf8");
  return file;
}
