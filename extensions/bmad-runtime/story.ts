import * as fs from "node:fs";
import * as path from "node:path";

export type StoryStatus = "draft" | "ready-for-dev" | "in-progress" | "review" | "done" | string;

export interface StoryAnalysis {
  status?: StoryStatus;
  uncheckedTaskCount: number;
  unresolvedReviewFindingCount: number;
  hasFileListEntries: boolean;
  hasDevAgentRecord: boolean;
  hasAcceptanceCriteria: boolean;
  hasConcreteAcceptanceCriteria: boolean;
  hasDebugLogReferences: boolean;
  hasCompletionNotes: boolean;
  hasTestOrCheckEvidence: boolean;
  hasSeniorDeveloperReview: boolean;
  hasApprovedReview: boolean;
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
  const acceptanceCriteria = sectionBody(text, /^##\s+Acceptance Criteria\s*$/i);
  const debugLog = sectionBody(text, /^###\s+Debug Log References\s*$/i);
  const completionNotes = sectionBody(text, /^###\s+Completion Notes List\s*$/i);
  const fileList = sectionBody(text, /^###\s+File List\s*$/i);

  const uncheckedTaskCount = (tasks.match(/^\s*- \[ \]/gm) ?? []).length;
  const unresolvedReviewFindingCount = (text.match(/^\s*- \[ \].*\[(?:AI-)?Review|^\s*- \[ \]\s*\[Review\]/gim) ?? []).length;
  const hasFileListEntries = fileList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line.startsWith("-") || line.startsWith("*") || line.startsWith("`") || /^[\w./\-]+$/.test(line));
  const hasDevAgentRecord = /^##\s+Dev Agent Record\s*$/im.test(text);
  const hasAcceptanceCriteria = acceptanceCriteria.trim().length > 0;
  const hasConcreteAcceptanceCriteria = /\bGiven\b[\s\S]*\bWhen\b[\s\S]*\bThen\b/i.test(acceptanceCriteria) && !/approved PRD, UX, architecture and epics/i.test(acceptanceCriteria);
  const hasDebugLogReferences = /^###\s+Debug Log References\s*$/im.test(text) && debugLog.trim().length > 0;
  const hasCompletionNotes = /^###\s+Completion Notes List\s*$/im.test(text) && completionNotes.trim().length > 0;
  const hasTestOrCheckEvidence = /(npm run smoke|npm test|npm run typecheck|vitest|pack --dry-run|passed)/i.test(debugLog);
  const hasSeniorDeveloperReview = /^##\s+(?:Additional\s+)?Senior Developer Review \(AI\)\s*$/im.test(text) || /^##\s+Senior Developer Review\s*$/im.test(text);
  const hasApprovedReview = /\*\*Outcome:\*\*\s*Approve/i.test(text) && /(No unresolved|Clean review|No decision-needed)/i.test(text);

  return {
    status: parseStoryStatus(text),
    uncheckedTaskCount,
    unresolvedReviewFindingCount,
    hasFileListEntries,
    hasDevAgentRecord,
    hasAcceptanceCriteria,
    hasConcreteAcceptanceCriteria,
    hasDebugLogReferences,
    hasCompletionNotes,
    hasTestOrCheckEvidence,
    hasSeniorDeveloperReview,
    hasApprovedReview,
  };
}

export function validateStoryDone(text: string): StoryValidationIssue[] {
  const analysis = analyzeStory(text);
  if (analysis.status !== "done") return [];

  const issues: StoryValidationIssue[] = [];
  if (analysis.uncheckedTaskCount > 0) issues.push({ severity: "error", message: `Story is marked done but has ${analysis.uncheckedTaskCount} unchecked task/subtask item(s).` });
  if (analysis.unresolvedReviewFindingCount > 0) issues.push({ severity: "error", message: `Story is marked done but has ${analysis.unresolvedReviewFindingCount} unresolved review finding(s).` });
  if (!analysis.hasAcceptanceCriteria) issues.push({ severity: "error", message: "Story is marked done but is missing acceptance criteria." });
  if (!analysis.hasConcreteAcceptanceCriteria) issues.push({ severity: "error", message: "Story is marked done but acceptance criteria are not concrete Given/When/Then criteria or still use generic proxy wording." });
  if (!analysis.hasDevAgentRecord) issues.push({ severity: "error", message: "Story is marked done but is missing a Dev Agent Record section." });
  if (!analysis.hasDebugLogReferences) issues.push({ severity: "error", message: "Story is marked done but is missing Debug Log References." });
  if (!analysis.hasCompletionNotes) issues.push({ severity: "error", message: "Story is marked done but is missing Completion Notes List." });
  if (!analysis.hasTestOrCheckEvidence) issues.push({ severity: "error", message: "Story is marked done but does not cite passing test/check evidence." });
  if (!analysis.hasFileListEntries) issues.push({ severity: "error", message: "Story is marked done but File List is empty or missing." });
  if (!analysis.hasSeniorDeveloperReview) issues.push({ severity: "error", message: "Story is marked done but is missing Senior Developer Review evidence." });
  if (!analysis.hasApprovedReview) issues.push({ severity: "error", message: "Story is marked done but does not have an approved clean review outcome." });
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
