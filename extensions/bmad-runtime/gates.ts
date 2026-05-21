import * as fs from "node:fs";
import * as path from "node:path";
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

export function isPlanningPhase(state: RuntimeState): boolean {
  return state.phase === "1-analysis" || state.phase === "2-planning" || state.mode === "interview";
}

export function shouldBlockMutationInPlanning(state: RuntimeState, cwd: string, toolName: string, input: Record<string, unknown>): string | undefined {
  if (!state.active || !isPlanningPhase(state)) return undefined;
  if (toolName !== "write" && toolName !== "edit") return undefined;

  const rel = normalizeToolPath(cwd, input.path ?? input.file_path);
  if (!rel) return undefined;
  const allowed = PLANNING_ALLOWED_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
  if (allowed) return undefined;

  return [
    "BMAD Runtime planning gate blocked a source mutation.",
    `Phase ${state.phase} / mode ${state.mode} is for interview, analysis, planning, docs, and BMAD artifacts only.`,
    `Blocked path: ${rel}`,
    "Move to Phase 3/4 autonomous mode with `/bmad autonomous` or explicitly exit with `/bmad exit` if you really want ad-hoc edits.",
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
