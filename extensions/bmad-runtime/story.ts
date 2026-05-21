import * as fs from "node:fs";
import * as path from "node:path";

export type StoryStatus = "draft" | "ready-for-dev" | "in-progress" | "review" | "done" | string;

export interface StoryAnalysis {
  status?: StoryStatus;
  uncheckedTaskCount: number;
  unresolvedReviewFindingCount: number;
  hasFileListEntries: boolean;
  hasDevAgentRecord: boolean;
}

export interface StoryValidationIssue {
  severity: "error" | "warning";
  message: string;
}

export interface StoryStatusFile {
  key: string;
  path: string;
  status?: StoryStatus;
}

function sectionBody(text: string, headingPattern: RegExp): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start === -1) return "";
  const startHeading = lines[start] ?? "";
  const level = startHeading.match(/^(#+)\s/)?.[1]?.length ?? 2;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heading = line.match(/^(#+)\s/);
    if (heading && heading[1] && heading[1].length <= level) break;
    body.push(line);
  }
  return body.join("\n");
}

export function parseStoryStatus(text: string): StoryStatus | undefined {
  const inline = text.match(/^Status:\s*([^\s#]+)\s*$/im);
  if (inline?.[1]) return inline[1].trim();

  const statusSection = sectionBody(text, /^##\s+Status\s*$/i).trim();
  if (!statusSection) return undefined;
  return statusSection.split(/\r?\n/)[0]?.trim();
}

export function analyzeStory(text: string): StoryAnalysis {
  const tasks = sectionBody(text, /^##\s+Tasks\s*\/\s*Subtasks\s*$/i) || sectionBody(text, /^##\s+Tasks\s*$/i);
  const fileList = sectionBody(text, /^###\s+File List\s*$/i);

  const uncheckedTaskCount = (tasks.match(/^\s*- \[ \]/gm) ?? []).length;
  const unresolvedReviewFindingCount = (text.match(/^\s*- \[ \].*\[(?:AI-)?Review|^\s*- \[ \]\s*\[Review\]/gim) ?? []).length;
  const hasFileListEntries = fileList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line.startsWith("-") || line.startsWith("*") || line.startsWith("`") || /^[\w./\\-]+$/.test(line));
  const hasDevAgentRecord = /^##\s+Dev Agent Record\s*$/im.test(text);

  return {
    status: parseStoryStatus(text),
    uncheckedTaskCount,
    unresolvedReviewFindingCount,
    hasFileListEntries,
    hasDevAgentRecord,
  };
}

export function validateStoryDone(text: string): StoryValidationIssue[] {
  const analysis = analyzeStory(text);
  if (analysis.status !== "done") return [];

  const issues: StoryValidationIssue[] = [];
  if (analysis.uncheckedTaskCount > 0) {
    issues.push({ severity: "error", message: `Story is marked done but has ${analysis.uncheckedTaskCount} unchecked task/subtask item(s).` });
  }
  if (analysis.unresolvedReviewFindingCount > 0) {
    issues.push({ severity: "error", message: `Story is marked done but has ${analysis.unresolvedReviewFindingCount} unresolved review finding(s).` });
  }
  if (!analysis.hasDevAgentRecord) {
    issues.push({ severity: "error", message: "Story is marked done but is missing a Dev Agent Record section." });
  }
  if (!analysis.hasFileListEntries) {
    issues.push({ severity: "error", message: "Story is marked done but File List is empty or missing." });
  }
  return issues;
}

export function deriveStoryKeyFromPath(filePath: string): string | undefined {
  const base = path.basename(filePath, path.extname(filePath));
  return /^\d+-\d+-/.test(base) ? base : undefined;
}

export function scanStoryStatusFiles(dir: string): StoryStatusFile[] {
  if (!fs.existsSync(dir)) return [];
  const out: StoryStatusFile[] = [];
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const key = deriveStoryKeyFromPath(full);
        if (!key) continue;
        try {
          out.push({ key, path: full, status: parseStoryStatus(fs.readFileSync(full, "utf8")) });
        } catch {
          // Ignore unreadable story candidates.
        }
      }
    }
  };
  walk(dir);
  return out;
}
