import * as fs from "node:fs";
import * as path from "node:path";
import type { BmadPathConfig } from "./paths.js";

export type SprintEntryKind = "epic" | "story" | "retrospective" | "unknown";

export type EpicStatus = "backlog" | "contexted" | "in-progress" | "done";
export type StoryStatus = "backlog" | "ready-for-dev" | "in-progress" | "review" | "done";
export type RetrospectiveStatus = "optional" | "done";
export type SprintStatus = EpicStatus | StoryStatus | RetrospectiveStatus | string;

export interface SprintStatusEntry {
  key: string;
  status: SprintStatus;
  kind: SprintEntryKind;
  line: number;
  epic?: number;
  story?: number;
}

export interface SprintStatusDocument {
  path?: string;
  entries: SprintStatusEntry[];
  developmentStatusLine?: number;
  lastUpdatedLine?: number;
  project?: string;
}

export interface SprintValidationIssue {
  severity: "error" | "warning";
  key?: string;
  line?: number;
  message: string;
}

export interface SprintTransitionResult {
  ok: boolean;
  reason?: string;
}

const EPIC_STATUSES = new Set(["backlog", "contexted", "in-progress", "done"]);
const STORY_STATUSES = new Set(["backlog", "ready-for-dev", "in-progress", "review", "done"]);
const RETRO_STATUSES = new Set(["optional", "done"]);

const STORY_TRANSITIONS = new Map<string, Set<string>>([
  ["backlog", new Set(["ready-for-dev"])],
  ["ready-for-dev", new Set(["in-progress"])],
  ["in-progress", new Set(["review"])],
  ["review", new Set(["in-progress", "done"])],
  ["done", new Set([])],
]);

const EPIC_TRANSITIONS = new Map<string, Set<string>>([
  ["backlog", new Set(["contexted", "in-progress"])],
  ["contexted", new Set(["in-progress"])],
  ["in-progress", new Set(["done"])],
  ["done", new Set([])],
]);

const RETRO_TRANSITIONS = new Map<string, Set<string>>([
  ["optional", new Set(["done"])],
  ["done", new Set([])],
]);

export function classifySprintKey(key: string): { kind: SprintEntryKind; epic?: number; story?: number } {
  const retrospective = key.match(/^epic-(\d+)-retrospective$/);
  if (retrospective?.[1]) return { kind: "retrospective", epic: Number(retrospective[1]) };

  const epic = key.match(/^epic-(\d+)$/);
  if (epic?.[1]) return { kind: "epic", epic: Number(epic[1]) };

  const story = key.match(/^(\d+)-(\d+)-/);
  if (story?.[1] && story?.[2]) return { kind: "story", epic: Number(story[1]), story: Number(story[2]) };

  return { kind: "unknown" };
}

export function parseSprintStatusText(text: string, filePath?: string): SprintStatusDocument {
  const lines = text.split(/\r?\n/);
  const entries: SprintStatusEntry[] = [];
  let inDevelopmentStatus = false;
  let developmentStatusLine: number | undefined;
  let lastUpdatedLine: number | undefined;
  let project: string | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;

    const lastUpdated = line.match(/^last_updated:\s*(.+?)\s*$/);
    if (lastUpdated) lastUpdatedLine = lineNumber;

    const projectMatch = line.match(/^project:\s*(.+?)\s*$/);
    if (projectMatch?.[1]) project = projectMatch[1].trim();

    if (/^development_status:\s*$/.test(line)) {
      inDevelopmentStatus = true;
      developmentStatusLine = lineNumber;
      continue;
    }

    if (!inDevelopmentStatus) continue;

    if (/^\S/.test(line) && !/^development_status:\s*$/.test(line)) break;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const entry = line.match(/^\s{2,}([A-Za-z0-9_.-]+):\s*([^#\s]+)\s*(?:#.*)?$/);
    if (!entry?.[1] || !entry?.[2]) continue;
    const classification = classifySprintKey(entry[1]);
    entries.push({
      key: entry[1],
      status: entry[2],
      kind: classification.kind,
      line: lineNumber,
      epic: classification.epic,
      story: classification.story,
    });
  }

  return { path: filePath, entries, developmentStatusLine, lastUpdatedLine, project };
}

export function parseSprintStatusLines(text: string): SprintStatusEntry[] {
  const entries: SprintStatusEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const match = line.match(/^\s*([A-Za-z0-9_.-]+):\s*([^#\s]+)\s*(?:#.*)?$/);
    if (!match?.[1] || !match?.[2]) continue;
    const classification = classifySprintKey(match[1]);
    if (classification.kind === "unknown") continue;
    entries.push({
      key: match[1],
      status: match[2],
      kind: classification.kind,
      line: index + 1,
      epic: classification.epic,
      story: classification.story,
    });
  }
  return entries;
}

export function isLegalStatus(kind: SprintEntryKind, status: string): boolean {
  if (kind === "epic") return EPIC_STATUSES.has(status);
  if (kind === "story") return STORY_STATUSES.has(status);
  if (kind === "retrospective") return RETRO_STATUSES.has(status);
  return false;
}

export function validateSprintTransition(kind: SprintEntryKind, from: string, to: string): SprintTransitionResult {
  if (from === to) return { ok: true };
  if (!isLegalStatus(kind, to)) return { ok: false, reason: `Illegal ${kind} status '${to}'.` };
  if (!isLegalStatus(kind, from)) return { ok: false, reason: `Cannot transition from illegal ${kind} status '${from}'.` };

  const map = kind === "story" ? STORY_TRANSITIONS : kind === "epic" ? EPIC_TRANSITIONS : kind === "retrospective" ? RETRO_TRANSITIONS : undefined;
  const allowed = map?.get(from);
  if (!allowed?.has(to)) return { ok: false, reason: `Illegal ${kind} transition '${from}' → '${to}'.` };
  return { ok: true };
}

export function validateSprintDocument(doc: SprintStatusDocument): SprintValidationIssue[] {
  const issues: SprintValidationIssue[] = [];
  if (!doc.developmentStatusLine) {
    issues.push({ severity: "error", message: "Missing development_status section." });
  }

  const seen = new Set<string>();
  for (const entry of doc.entries) {
    if (seen.has(entry.key)) {
      issues.push({ severity: "error", key: entry.key, line: entry.line, message: `Duplicate sprint-status key '${entry.key}'.` });
    }
    seen.add(entry.key);

    if (entry.kind === "unknown") {
      issues.push({ severity: "warning", key: entry.key, line: entry.line, message: `Unknown sprint-status entry shape '${entry.key}'.` });
      continue;
    }

    if (!isLegalStatus(entry.kind, entry.status)) {
      issues.push({ severity: "error", key: entry.key, line: entry.line, message: `Illegal ${entry.kind} status '${entry.status}'.` });
    }
  }

  return issues;
}

export function summarizeSprint(doc: SprintStatusDocument): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const entry of doc.entries) {
    const key = `${entry.kind}:${entry.status}`;
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

export function findFirstStoryWithStatus(doc: SprintStatusDocument, status: StoryStatus): SprintStatusEntry | undefined {
  return doc.entries.find((entry) => entry.kind === "story" && entry.status === status);
}

export function getSprintStatusPath(cfg: BmadPathConfig): string {
  return path.join(cfg.implementation_artifacts, "sprint-status.yaml");
}

export function loadSprintStatus(cfg: BmadPathConfig): { exists: boolean; path: string; doc?: SprintStatusDocument; error?: string } {
  const filePath = getSprintStatusPath(cfg);
  if (!fs.existsSync(filePath)) return { exists: false, path: filePath };
  try {
    return { exists: true, path: filePath, doc: parseSprintStatusText(fs.readFileSync(filePath, "utf8"), filePath) };
  } catch (error) {
    return { exists: true, path: filePath, error: error instanceof Error ? error.message : String(error) };
  }
}
