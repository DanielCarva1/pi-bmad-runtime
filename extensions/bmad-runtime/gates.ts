import * as fs from "node:fs";
import * as path from "node:path";
import { classifyPromptRequirement, formatOwnerApprovalBlock, type HighRiskPromptActionKind } from "./prompt-policy.js";
import { parseSprintStatusLines, parseSprintStatusText, validateSprintDocument, validateSprintTransition } from "./sprint.js";
import { validateStoryDone } from "./story.js";
import type { RuntimeState } from "./state.js";

const PLANNING_ALLOWED_PREFIXES = [
  "_bmad-output",
  "_bmad",
  "docs",
  "CONTEXT.md",
  "CONTEXT-MAP.md",
  "README.md",
  ".bmad-runtime",
];

function normalizeToolPath(cwd: string, inputPath: unknown): string | undefined {
  if (typeof inputPath !== "string" || !inputPath.trim()) return undefined;
  const raw = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  return path.relative(cwd, absolute).replaceAll(path.sep, "/");
}

function isSprintStatusPath(rel: string): boolean {
  return rel.endsWith("sprint-status.yaml") || rel.endsWith("sprint-status.yml");
}

function isTargetCodeRepoPath(rel: string): boolean {
  const normalized = rel.replaceAll("\\", "/");
  return normalized === "../pi-bmad-runtime" || normalized.startsWith("../pi-bmad-runtime/");
}

function isPhase3BoundaryActive(state: RuntimeState): boolean {
  return state.phase === "3-solutioning" || isPlanningPhase(state);
}

function targetCodeRepoBlock(reason: string): string {
  return [
    "BMAD Runtime Target Code Repo boundary blocked a Phase 3 mutation.",
    reason,
    "Boundary: Target Code Repo is read-only during Phase 3; writeOccurred: false.",
    "Recovery: advance to Phase 4 with a ready story/gate evidence, or record an explicit future waiver before mutating product code.",
  ].join("\n");
}

function externalPublicationBlock(action: string, command: string): string {
  const policyKind = classifyExternalPublicationPolicyKind(action);
  const decision = classifyPromptRequirement({ kind: policyKind, state: { phase: "4-implementation", mode: "autonomous" }, action, command });
  return [
    "BMAD Runtime external-publication gate blocked an external write.",
    `Action: ${action}`,
    command ? `Command: ${command}` : "Command: structured tool call",
    formatOwnerApprovalBlock(decision, { action, command }),
  ].join("\n");
}

function classifyExternalPublicationPolicyKind(action: string): HighRiskPromptActionKind {
  return /\b(?:git|github|remote|repo)\b/i.test(action) ? "remote-write" : "deploy-publication";
}

function classifyExternalPublicationAction(toolName: string, input: Record<string, unknown>, command: string): string | undefined {
  const lower = command.toLowerCase();
  const bashPatterns: Array<[RegExp, string]> = [
    [/\bgit(?:\s+-c\s+\S+)*\s+(?:-C\s+\S+\s+)?remote\s+add\b/i, "git remote add"],
    [/\bgit(?:\s+-c\s+\S+)*\s+(?:-C\s+\S+\s+)?push\b/i, "git push"],
    [/\bgh\s+repo\s+create\b/i, "GitHub repository creation"],
    [/\bgh\s+release\s+create\b/i, "GitHub release publication"],
    [/\bcurl\b[\s\S]*api\.github\.com[\s\S]*(?:\/repos|\/user\/repos)/i, "GitHub API repository write"],
    [/\bnpm\s+publish\b/i, "npm publish"],
    [/\bpnpm\s+publish\b/i, "pnpm publish"],
    [/\byarn\s+npm\s+publish\b/i, "yarn npm publish"],
    [/\bvercel\s+(?:deploy|--prod|prod)\b/i, "Vercel deploy"],
    [/\bnetlify\s+deploy\b/i, "Netlify deploy"],
    [/\bflyctl\s+deploy\b/i, "Fly deploy"],
    [/\bdeploy\b/i, "deploy/publication"],
  ];
  if (toolName === "bash") {
    const match = bashPatterns.find(([pattern]) => pattern.test(lower));
    return match?.[1];
  }

  const toolPayload = `${toolName}\n${JSON.stringify(input).toLowerCase()}`;
  if (/(github|gh)/i.test(toolName) && /\b(create|publish|release|repo|push)\b/i.test(toolPayload))
    return "GitHub external write";
  if (/(vercel|netlify|deploy)/i.test(toolName) && /\b(deploy|publish|promote|production)\b/i.test(toolPayload))
    return "deploy/publication";
  return undefined;
}

function mutatingCommandTargetsTargetRepo(command: string): boolean {
  const target = String.raw`["']?(?:\.\.[/\\]pi-bmad-runtime)["']?`;
  const targetPath = String.raw`["']?(?:\.\.[/\\]pi-bmad-runtime(?:[/\\][^\s"';&|]*)?)["']?`;
  const writeToolWithTarget = String.raw`\b(?:apply_patch|touch|mkdir|rm|sed\s+-i)\b[\s\S]*${targetPath}`;
  const teeToTarget = String.raw`\btee\b[\s\S]*${targetPath}`;
  const moveWithTarget = String.raw`\bmv\b[\s\S]*${targetPath}`;
  const copyToTarget = String.raw`\bcp\b[\s\S]+\s+${targetPath}(?:\s|$)`;
  const cdIntoTargetThenMutate = String.raw`\bcd\s+${target}\b[\s\S]*(?:&&|;)\s*(?:apply_patch|touch|mkdir|rm|mv|cp|sed\s+-i|tee\b|git\s+(?:add|commit|reset|checkout|switch|merge|rebase|clean|restore)\b|npm\s+(?:install|i|ci|version|run\s+(?:build|prepare|format|lint:fix|fix|prepack|pack))\b)`;
  const gitMutation = String.raw`\bgit\s+-C\s+${target}\s+(?:add|commit|reset|checkout|switch|merge|rebase|clean|restore)\b`;
  const npmMutation = String.raw`\bnpm\s+(?:--prefix\s+${target}\s+)?(?:install|i|ci|version|run\s+(?:build|prepare|format|lint:fix|fix|prepack|pack))\b`;
  const redirectToTarget = String.raw`(?:>|>>|>\||&>|2>)\s*${targetPath}`;
  return (
    new RegExp(writeToolWithTarget, "i").test(command) ||
    new RegExp(teeToTarget, "i").test(command) ||
    new RegExp(moveWithTarget, "i").test(command) ||
    new RegExp(copyToTarget, "i").test(command) ||
    new RegExp(cdIntoTargetThenMutate, "i").test(command) ||
    new RegExp(gitMutation, "i").test(command) ||
    (new RegExp(target, "i").test(command) && new RegExp(npmMutation, "i").test(command)) ||
    new RegExp(redirectToTarget, "i").test(command)
  );
}

function validateSprintWrite(content: unknown): string | undefined {
  if (typeof content !== "string") return undefined;
  const issues = validateSprintDocument(parseSprintStatusText(content));
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length === 0) return undefined;
  return [
    "BMAD Runtime sprint gate blocked invalid sprint-status content:",
    ...errors.slice(0, 8).map((issue) => `- ${issue.line ? `line ${issue.line}: ` : ""}${issue.message}`),
  ].join("\n");
}

function validateSprintEdit(edits: unknown): string | undefined {
  if (!Array.isArray(edits)) return undefined;
  const failures: string[] = [];
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") continue;
    const oldText = (edit as { oldText?: unknown }).oldText;
    const newText = (edit as { newText?: unknown }).newText;
    if (typeof oldText !== "string" || typeof newText !== "string") continue;

    const oldEntries = new Map(parseSprintStatusLines(oldText).map((entry) => [entry.key, entry]));
    for (const next of parseSprintStatusLines(newText)) {
      if (next.kind === "unknown") continue;
      const previous = oldEntries.get(next.key);
      if (!previous) {
        const illegal = validateSprintDocument({ entries: [next], developmentStatusLine: 1 }).some((issue) => issue.severity === "error");
        if (illegal) failures.push(`${next.key}: illegal new status '${next.status}'`);
        continue;
      }
      const result = validateSprintTransition(next.kind, String(previous.status), String(next.status));
      if (!result.ok) failures.push(`${next.key}: ${result.reason}`);
    }
  }
  if (failures.length === 0) return undefined;
  return [
    "BMAD Runtime sprint gate blocked illegal sprint-status transition:",
    ...failures.slice(0, 8).map((failure) => `- ${failure}`),
  ].join("\n");
}

function isStoryPath(rel: string): boolean {
  return rel.endsWith(".md") && rel.includes("implementation-artifacts/") && /(?:^|\/)\d+-\d+-[^/]+\.md$/.test(rel);
}

function applyEditsToCurrentFile(cwd: string, input: Record<string, unknown>): string | undefined {
  const rel = normalizeToolPath(cwd, input.path ?? input.file_path);
  if (!rel) return undefined;
  const absolute = path.resolve(cwd, rel);
  if (!fs.existsSync(absolute)) return undefined;
  const edits = input.edits;
  if (!Array.isArray(edits)) return undefined;

  let content = fs.readFileSync(absolute, "utf8");
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") continue;
    const oldText = (edit as { oldText?: unknown }).oldText;
    const newText = (edit as { newText?: unknown }).newText;
    if (typeof oldText !== "string" || typeof newText !== "string") continue;
    const index = content.indexOf(oldText);
    if (index === -1) return undefined;
    content = `${content.slice(0, index)}${newText}${content.slice(index + oldText.length)}`;
  }
  return content;
}

function validateStoryContent(content: unknown): string | undefined {
  if (typeof content !== "string") return undefined;
  const issues = validateStoryDone(content).filter((issue) => issue.severity === "error");
  if (issues.length === 0) return undefined;
  return [
    "BMAD Runtime story gate blocked premature done status:",
    ...issues.slice(0, 8).map((issue) => `- ${issue.message}`),
  ].join("\n");
}

export function isPotentialWriteToolCall(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "write" || toolName === "edit" || toolName === "apply_patch") return true;
  if (toolName !== "bash") return false;
  const command = typeof input.command === "string" ? input.command : "";
  return /(?:>>|>\||&>|2>|>)\s*\S+/.test(command) ||
    /\b(?:apply_patch|touch|mkdir|rm|mv|cp|tee|truncate|rsync|sed\s+-i|perl\s+-pi)\b/i.test(command) ||
    /\b(?:node|python|python3|ruby|perl)\s+-e\b/i.test(command) ||
    /\bgit(?:\s+-C\s+\S+)?\s+(?:add|commit|reset|checkout|switch|merge|rebase|clean|restore)\b/i.test(command) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:--prefix\s+\S+\s+)?(?:install|i|ci|add|version|run\s+(?:build|prepare|format|lint:fix|fix|prepack|pack))\b/i.test(command);
}

export function shouldBlockWriteForAmbiguousResolution(
  confidence: string | undefined,
  toolName: string,
  input: Record<string, unknown>,
  reason = "active project resolution is ambiguous or unsafe",
  context: { nextSafeAction?: string; recoveryAction?: string; cwd?: string } = {},
): string | undefined {
  const unsafe = confidence === "ambiguous" || confidence === "blocked" || confidence === "new_project_intent_required" || confidence === "local_workspace_unregistered" || confidence === "needs_rebind" || confidence === "variant_choice_required";
  if (!unsafe) return undefined;
  if (!isPotentialWriteToolCall(toolName, input)) return undefined;
  const action = describeWriteAction(toolName, input, context.cwd);
  const nextSafeAction = context.nextSafeAction ?? "choose the project explicitly, run confirmed rebind, or complete variant choice before writing";
  return [
    "BMAD Runtime active-project-resolution gate blocked a write.",
    `Cause: ${reason}`,
    `Confidence: ${confidence}; writeOccurred: false.`,
    `Action: ${action.action}`,
    action.path ? `Path: ${action.path}` : undefined,
    action.command ? `Command: ${action.command}` : undefined,
    `Next safe action: ${nextSafeAction}`,
    `Recovery: ${context.recoveryAction ?? nextSafeAction}`,
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function describeWriteAction(toolName: string, input: Record<string, unknown>, cwd?: string): { action: string; path?: string; command?: string } {
  if (toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return { action: "bash mutation", command };
  }
  if (toolName === "apply_patch") {
    const patch = [input.input, input.patch, input.content].filter((value): value is string => typeof value === "string").join("\n");
    const match = patch.match(/^\*\*\*\s+(?:Update|Add|Delete) File:\s+(.+)$/im);
    return { action: "apply_patch", path: match?.[1]?.trim() };
  }
  const rel = normalizeToolPath(cwd ?? process.cwd(), input.path ?? input.file_path);
  return { action: toolName, path: rel };
}

export function isPlanningPhase(state: RuntimeState): boolean {
  return state.phase === "1-analysis" || state.phase === "2-planning" || state.mode === "interview";
}

export function shouldBlockMutationInPlanning(state: RuntimeState, cwd: string, toolName: string, input: Record<string, unknown>): string | undefined {
  if (!state.active) return undefined;
  if (toolName !== "write" && toolName !== "edit") return undefined;

  const rel = normalizeToolPath(cwd, input.path ?? input.file_path);
  if (!rel) return undefined;
  if (isPhase3BoundaryActive(state) && isTargetCodeRepoPath(rel)) return targetCodeRepoBlock(`Blocked path: ${rel}`);
  if (!isPlanningPhase(state)) return undefined;
  const allowed = PLANNING_ALLOWED_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
  if (allowed) return undefined;

  return [
    "BMAD Runtime planning gate blocked a source mutation.",
    `Phase ${state.phase} / mode ${state.mode} is for interview, analysis, planning, docs, and BMAD artifacts only.`,
    `Blocked path: ${rel}`,
    "Resume through `/bmad-start` or explicitly exit with `/bmad exit` if you really want ad-hoc edits.",
  ].join("\n");
}

export function shouldBlockSprintStatusMutation(state: RuntimeState, cwd: string, toolName: string, input: Record<string, unknown>): string | undefined {
  if (!state.active) return undefined;
  if (toolName !== "write" && toolName !== "edit") return undefined;

  const rel = normalizeToolPath(cwd, input.path ?? input.file_path);
  if (!rel || !isSprintStatusPath(rel)) return undefined;

  if (toolName === "write") return validateSprintWrite(input.content);
  return validateSprintEdit(input.edits);
}

export function shouldBlockStoryDoneMutation(state: RuntimeState, cwd: string, toolName: string, input: Record<string, unknown>): string | undefined {
  if (!state.active) return undefined;
  if (toolName !== "write" && toolName !== "edit") return undefined;

  const rel = normalizeToolPath(cwd, input.path ?? input.file_path);
  if (!rel || !isStoryPath(rel)) return undefined;

  if (toolName === "write") return validateStoryContent(input.content);
  const simulated = applyEditsToCurrentFile(cwd, input);
  return validateStoryContent(simulated);
}

export function shouldBlockDangerousToolCall(state: RuntimeState, cwd: string, toolName: string, input: Record<string, unknown>): string | undefined {
  if (!state.active) return undefined;

  const command = typeof input.command === "string" ? input.command : "";
  const externalAction = classifyExternalPublicationAction(toolName, input, command);
  if (externalAction) return externalPublicationBlock(externalAction, command);
  const dangerousPatterns: Array<{ pattern: RegExp; kind: HighRiskPromptActionKind; action: string }> = [
    { pattern: /\brm\s+-rf\b/i, kind: "destructive-action", action: "recursive remove" },
    { pattern: /\brmdir\s+\/s\b/i, kind: "destructive-action", action: "recursive directory remove" },
    { pattern: /\bdel\s+\/f\b/i, kind: "destructive-action", action: "force delete" },
    { pattern: /\bkubectl\b/i, kind: "deploy-publication", action: "cluster command" },
    { pattern: /\bterraform\s+apply\b/i, kind: "deploy-publication", action: "terraform apply" },
    { pattern: /\b(?:openai_api_key|github_token|api[_-]?key\s*=|password\s*=|secret\s*=|--token\b|authorization:\s*bearer|setx\s+\S*token)\b/i, kind: "credentials", action: "credential or secret usage" },
    { pattern: /\b(?:stripe|billing|payment|subscribe|subscription|upgrade\s+(?:plan|tier)|paid\s+service)\b/i, kind: "paid-service", action: "paid service or billing operation" },
  ];
  const dangerousMatch = toolName === "bash" ? dangerousPatterns.find(({ pattern }) => pattern.test(command)) : undefined;
  if (dangerousMatch) {
    const decision = classifyPromptRequirement({ kind: dangerousMatch.kind, state, action: dangerousMatch.action, command });
    return [
      "BMAD Runtime safety gate blocked a potentially destructive/external/credential/publish action.",
      formatOwnerApprovalBlock(decision, { action: dangerousMatch.action, command, toolName }),
    ].join("\n");
  }

  if (toolName === "bash" && isPhase3BoundaryActive(state) && mutatingCommandTargetsTargetRepo(command)) {
    return targetCodeRepoBlock(`Command: ${command}`);
  }

  if (toolName === "apply_patch" && isPhase3BoundaryActive(state)) {
    const patchText = [input.input, input.patch, input.content]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (patchText.includes("../pi-bmad-runtime") || patchText.includes(String.raw`..\pi-bmad-runtime`)) {
      return targetCodeRepoBlock("Patch targets ../pi-bmad-runtime.");
    }
  }

  const rel = normalizeToolPath(cwd, input.path ?? input.file_path);
  if ((toolName === "write" || toolName === "edit") && rel && isPhase3BoundaryActive(state) && isTargetCodeRepoPath(rel)) {
    return targetCodeRepoBlock(`Path: ${rel}`);
  }
  if ((toolName === "write" || toolName === "edit") && rel?.startsWith("../")) {
    return [
      "BMAD Runtime safety gate blocked a write outside the active workspace.",
      `Path: ${rel}`,
      "Reference-project writes require explicit owner confirmation.",
    ].join("\n");
  }
}
