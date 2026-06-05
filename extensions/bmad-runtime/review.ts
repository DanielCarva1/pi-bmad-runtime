import * as fs from "node:fs";
import * as path from "node:path";
import { createDelegationContract, getPublishedSubagentsService, runDelegationContract, type DelegationContract, type SubagentsServiceLike } from "./delegation.js";

export type ReviewFindingClassification = "patch-required" | "decision-needed" | "accepted-risk" | "no-action";
export type ReviewRoleId = "blind-hunter" | "edge-case-hunter" | "acceptance-auditor";

export interface ReviewFinding {
  title: string;
  detail: string;
  source: string;
  classification: ReviewFindingClassification;
  severity?: "high" | "medium" | "low";
  role?: ReviewRoleId;
}

export interface ReviewSynthesis {
  unresolvedPatchCount: number;
  decisionNeededCount: number;
  acceptedRiskCount: number;
  noActionCount: number;
  duplicateCount: number;
  uniqueFindings: ReviewFinding[];
  summary: string;
}

export interface ReviewRoleSpec {
  id: ReviewRoleId;
  label: string;
  agentType: string;
  focus: string;
}

export interface ReviewDelegationInput {
  storyKey: string;
  storyPath: string;
  changedPaths: string[];
  acceptanceCriteria: string[];
  evidenceLinks: string[];
  cwd: string;
  evidenceDir?: string;
  service?: SubagentsServiceLike;
}

export interface ReviewRoleResult {
  role: ReviewRoleId;
  agentId?: string;
  independent: boolean;
  status: "spawned" | "completed" | "degraded" | "blocked";
  prompt: string;
  output?: string;
  findings: ReviewFinding[];
}

export interface ParallelReviewRunResult {
  storyKey: string;
  mode: "real-subagents" | "degraded-same-session";
  independentRoles: boolean;
  roleResults: ReviewRoleResult[];
  synthesis: ReviewSynthesis;
  evidencePath?: string;
  doneGate: "pass" | "blocked" | "degraded";
  detail: string;
}

export const REVIEW_ROLES: ReviewRoleSpec[] = [
  { id: "blind-hunter", label: "Blind Hunter", agentType: "qa-reviewer", focus: "Find defects without assuming the implementation is correct. Prioritize code and behavior risks." },
  { id: "edge-case-hunter", label: "Edge Case Hunter", agentType: "qa-reviewer", focus: "Walk boundary conditions, invalid states, restart/resume paths and failure modes." },
  { id: "acceptance-auditor", label: "Acceptance Auditor", agentType: "qa-reviewer", focus: "Map every acceptance criterion and evidence requirement to concrete proof or a gap." },
];

function keyForFinding(finding: ReviewFinding): string {
  return `${finding.classification}:${finding.title}:${finding.detail}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function deduplicateReviewFindings(findings: ReviewFinding[]): { unique: ReviewFinding[]; duplicateCount: number } {
  const seen = new Map<string, ReviewFinding>();
  let duplicateCount = 0;
  for (const finding of findings) {
    const key = keyForFinding(finding);
    if (seen.has(key)) duplicateCount += 1;
    else seen.set(key, finding);
  }
  return { unique: [...seen.values()], duplicateCount };
}

export function synthesizeReviewFindings(findings: ReviewFinding[]): ReviewSynthesis {
  const { unique, duplicateCount } = deduplicateReviewFindings(findings);
  const unresolvedPatchCount = unique.filter((finding) => finding.classification === "patch-required").length;
  const decisionNeededCount = unique.filter((finding) => finding.classification === "decision-needed").length;
  const acceptedRiskCount = unique.filter((finding) => finding.classification === "accepted-risk").length;
  const noActionCount = unique.filter((finding) => finding.classification === "no-action").length;
  return { unresolvedPatchCount, decisionNeededCount, acceptedRiskCount, noActionCount, duplicateCount, uniqueFindings: unique, summary: `patch=${unresolvedPatchCount}, decision=${decisionNeededCount}, accepted-risk=${acceptedRiskCount}, no-action=${noActionCount}, duplicates=${duplicateCount}` };
}

export function reviewBlocksDone(findings: ReviewFinding[]): boolean {
  const synthesis = synthesizeReviewFindings(findings);
  return synthesis.unresolvedPatchCount > 0 || synthesis.decisionNeededCount > 0;
}

function classifyText(text: string): ReviewFindingClassification {
  const lower = text.toLowerCase();
  if (lower.includes("patch-required") || lower.includes("patch required") || lower.includes("must fix")) return "patch-required";
  if (lower.includes("decision-needed") || lower.includes("decision needed") || lower.includes("owner decision")) return "decision-needed";
  if (lower.includes("accepted-risk") || lower.includes("accepted risk")) return "accepted-risk";
  return "no-action";
}

export function parseReviewFindings(output: string, role: ReviewRoleId): ReviewFinding[] {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const findings: ReviewFinding[] = [];
  for (const line of lines) {
    const match = line.match(/^(?:[-*]\s*)?\[?(patch-required|decision-needed|accepted-risk|no-action)\]?\s*[:|-]\s*(.+)$/i);
    if (!match?.[1] || !match?.[2]) continue;
    findings.push({ title: match[2].slice(0, 90), detail: match[2], source: role, role, classification: match[1].toLowerCase() as ReviewFindingClassification });
  }
  if (findings.length === 0 && /no findings|clean|approve|no-action/i.test(output)) {
    findings.push({ title: "No actionable findings", detail: output.slice(0, 400), source: role, role, classification: "no-action" });
  }
  return findings.length ? findings : [{ title: "Unclassified reviewer output", detail: output.slice(0, 400), source: role, role, classification: classifyText(output) }];
}
function readSnippet(file: string, maxChars = 6000): string {
  try {
    return fs.readFileSync(file, "utf8").slice(0, maxChars);
  } catch {
    return `Unable to read ${file}`;
  }
}

export function createReviewDelegationContracts(input: ReviewDelegationInput): DelegationContract[] {
  const storySnippet = readSnippet(path.isAbsolute(input.storyPath) ? input.storyPath : path.join(input.cwd, input.storyPath));
  return REVIEW_ROLES.map((role) => createDelegationContract({
    owner: role.label,
    role: role.label,
    objective: `Review ${input.storyKey} as ${role.label}`,
    context: [
      `Story key: ${input.storyKey}`,
      `Story path: ${input.storyPath}`,
      `Role focus: ${role.focus}`,
      `Changed paths: ${input.changedPaths.join(", ") || "not supplied"}`,
      `Evidence links: ${input.evidenceLinks.join(", ") || "not supplied"}`,
      "Story excerpt:",
      storySnippet,
    ],
    allowedPaths: [input.storyPath, ...input.changedPaths],
    acceptanceCriteria: input.acceptanceCriteria,
    dependencies: input.evidenceLinks,
    riskLimits: ["Read-only review", "Do not mutate files", "Do not spawn subagents", "Do not broaden scope beyond the story and listed paths"],
    expectedOutput: "Independent review findings classified as patch-required, decision-needed, accepted-risk, or no-action with file/evidence references.",
    stopCriteria: ["Report all findings", "Stop if required evidence is unavailable", "Stop if scope exceeds the contract"],
    maySubdelegate: false,
  }));
}

export function buildReviewDelegationPrompt(input: ReviewDelegationInput): string {
  return [
    `BMAD parallel review for story ${input.storyKey}`,
    "Spawn these reviewers in parallel with bounded context:",
    ...REVIEW_ROLES.map((role) => `- ${role.label}: ${role.focus}`),
    "",
    "Each reviewer must classify findings as patch-required, decision-needed, accepted-risk, or no-action.",
    "After all reviewers finish, deduplicate findings and block done status if any patch-required or decision-needed finding remains.",
  ].join("\n");
}

export async function runParallelReviewDelegation(input: ReviewDelegationInput): Promise<ParallelReviewRunResult> {
  const service = input.service ?? getPublishedSubagentsService();
  const contracts = createReviewDelegationContracts(input);
  const roleResults: ReviewRoleResult[] = [];

  for (const [index, contract] of contracts.entries()) {
    const role = REVIEW_ROLES[index];
    if (!role) continue;
    const result = runDelegationContract(contract, { cwd: input.cwd, service, agentType: role.agentType, description: `${role.label} review`, maxTurns: 20 });
    roleResults.push({ role: role.id, agentId: result.agentId, independent: result.independentExecution, status: result.status === "spawned" ? "spawned" : result.status, prompt: result.prompt, findings: [] });
  }

  if (service?.waitForAll && roleResults.some((result) => result.agentId)) await service.waitForAll();

  for (const result of roleResults) {
    if (!result.agentId || !service?.getRecord) continue;
    const record = service.getRecord(result.agentId);
    const output = record?.result ?? record?.error ?? "";
    result.output = output;
    result.status = record?.status === "completed" ? "completed" : result.status;
    result.findings = parseReviewFindings(output, result.role);
  }

  const independentRoles = roleResults.length === REVIEW_ROLES.length && roleResults.every((result) => result.independent);
  const findings = roleResults.flatMap((result) => result.findings);
  const synthesis = synthesizeReviewFindings(findings);
  const doneGate = independentRoles ? reviewBlocksDone(synthesis.uniqueFindings) ? "blocked" : "pass" : "degraded";
  const run: ParallelReviewRunResult = {
    storyKey: input.storyKey,
    mode: independentRoles ? "real-subagents" : "degraded-same-session",
    independentRoles,
    roleResults,
    synthesis,
    doneGate,
    detail: independentRoles ? "Parallel independent review roles executed through the Pi subagents service." : "Review role prompts were prepared, but real independent subagent execution was unavailable; output is degraded.",
  };
  run.evidencePath = writeReviewEvidence(input.cwd, run, input.evidenceDir);
  return run;
}

export function writeReviewEvidence(cwd: string, run: ParallelReviewRunResult, evidenceDir?: string): string {
  const dir = evidenceDir ?? path.join(cwd, "_bmad-output", "evidence", "reviews");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run.storyKey}-parallel-review-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  const lines = [
    "# BMAD Parallel Review Evidence", "", `- Story: ${run.storyKey}`, `- Mode: ${run.mode}`, `- Independent roles: ${run.independentRoles ? "yes" : "no"}`, `- Done gate: ${run.doneGate}`, `- Synthesis: ${run.synthesis.summary}`, "", "## Role Results", "",
    ...run.roleResults.flatMap((result) => [`### ${result.role}`, "", `- Status: ${result.status}`, result.agentId ? `- Agent id: ${result.agentId}` : "- Agent id: none", `- Independent: ${result.independent ? "yes" : "no"}`, "- Findings:", ...(result.findings.length ? result.findings.map((finding) => `  - [${finding.classification}] ${finding.title}`) : ["  - none"]), ""]),
    "## Unique Findings", "", ...(run.synthesis.uniqueFindings.length ? run.synthesis.uniqueFindings.map((finding) => `- [${finding.classification}] ${finding.title} — ${finding.source}`) : ["- none"]), "",
  ];
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

export function formatReviewRunResult(run: ParallelReviewRunResult): string {
  return [
    `BMAD parallel review: ${run.storyKey}`,
    `Mode: ${run.mode}`,
    `Independent roles: ${run.independentRoles ? "yes" : "no"}`,
    `Done gate: ${run.doneGate}`,
    `Synthesis: ${run.synthesis.summary}`,
    run.evidencePath ? `Evidence: ${run.evidencePath}` : undefined,
    ...run.roleResults.map((result) => `- ${result.role}: ${result.status}${result.agentId ? ` (${result.agentId})` : ""}`),
  ].filter((line): line is string => Boolean(line)).join("\n");
}
