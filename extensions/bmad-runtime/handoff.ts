import * as fs from "node:fs";
import * as path from "node:path";
import { getStateDir, summarizeStateForSession, type RuntimeState } from "./state.js";

export interface RuntimeHandoffInput {
  reason: string;
  state: RuntimeState;
  nextStep?: string;
  note?: string;
  messages?: unknown[];
}

export interface RuntimeHandoffResult {
  absolutePath: string;
  relativePath: string;
  updatedAt: string;
}

const ASSISTANT_EXCERPT_LIMIT = 1400;

function textFromMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as { role?: unknown; content?: unknown; text?: unknown };
  if (value.role !== "assistant") return undefined;
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    return value.content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const item = block as { type?: unknown; text?: unknown };
        return item.type === "text" && typeof item.text === "string" ? item.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return undefined;
}

function lastAssistantExcerpt(messages: unknown[] | undefined): string | undefined {
  if (!messages?.length) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = textFromMessage(messages[index])?.trim();
    if (!text) continue;
    return text.length > ASSISTANT_EXCERPT_LIMIT
      ? `${text.slice(0, ASSISTANT_EXCERPT_LIMIT).trim()}\n[truncated]`
      : text;
  }
  return undefined;
}

function formatHandoff(input: RuntimeHandoffInput, updatedAt: string): string {
  const summary = summarizeStateForSession(input.state);
  const assistantExcerpt = lastAssistantExcerpt(input.messages);
  const lines = [
    "# BMAD Runtime Handoff",
    "",
    `Updated at: ${updatedAt}`,
    `Reason: ${input.reason}`,
    "",
    "## Runtime Anchor",
    "",
    `- Active: ${summary.active}`,
    `- Mode: ${summary.mode}`,
    `- Track: ${summary.track}`,
    `- Phase: ${summary.phase}`,
    `- Current workflow: ${summary.currentWorkflow ?? "none"}`,
    `- Current story: ${summary.currentStory ?? "none"}`,
    `- Last run: ${summary.lastRun ? `${summary.lastRun.skill} at ${summary.lastRun.launchedAt}` : "none"}`,
    `- Workflow history count: ${summary.workflowHistoryCount}`,
    "",
    "## Next Step",
    "",
    input.nextStep?.trim() || "Run /bmad status and continue from the runtime recommendation.",
  ];
  if (input.note?.trim()) lines.push("", "## Note", "", input.note.trim());
  if (assistantExcerpt) lines.push("", "## Last Assistant Excerpt", "", "```text", assistantExcerpt, "```");
  lines.push(
    "",
    "## Resume Rules",
    "",
    "- Treat this handoff as a bootstrap hint; runtime state and canonical artifacts remain source of truth.",
    "- Keep context lean: inspect full artifacts only when needed for the next BMAD action.",
    "- Do not mix this project with another BMAD project or with the runtime package repository.",
    "",
  );
  return lines.join("\n");
}

export function writeRuntimeHandoff(cwd: string, input: RuntimeHandoffInput): RuntimeHandoffResult {
  const updatedAt = new Date().toISOString();
  const dir = path.join(getStateDir(cwd), "handoffs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "latest-handoff.md");
  fs.writeFileSync(file, formatHandoff(input, updatedAt), "utf8");
  return {
    absolutePath: file,
    relativePath: path.relative(cwd, file).replaceAll(path.sep, "/"),
    updatedAt,
  };
}
