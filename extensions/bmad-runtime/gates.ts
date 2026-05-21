import * as path from "node:path";
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
