import * as fs from "node:fs";
import * as path from "node:path";
import type { BmadPathConfig } from "./paths.js";
import { toProjectRelative } from "./paths.js";
import type { RuntimeState } from "./state.js";

export interface LedgerSummary {
  workflowHistoryCount: number;
  recentWorkflows: string[];
  evidenceFiles: string[];
  storyFiles: string[];
}

function listMarkdownFiles(dir: string, limit: number): string[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
  return files.slice(-limit);
}

export function summarizeLedger(state: RuntimeState, cfg: BmadPathConfig): LedgerSummary {
  const evidenceDir = path.join(cfg.output_folder, "evidence");
  return {
    workflowHistoryCount: state.workflowHistory.length,
    recentWorkflows: state.workflowHistory.slice(-5).map((entry) => `${entry.skill} @ ${entry.launchedAt}`),
    evidenceFiles: listMarkdownFiles(evidenceDir, 8).map((file) => toProjectRelative(cfg.projectRoot, file)),
    storyFiles: listMarkdownFiles(cfg.implementation_artifacts, 8).map((file) => toProjectRelative(cfg.projectRoot, file)),
  };
}

export function formatLedgerSummary(summary: LedgerSummary): string {
  return [
    "Ledger and evidence summary:",
    `- Workflow history entries: ${summary.workflowHistoryCount}`,
    "- Recent workflows:",
    ...(summary.recentWorkflows.length ? summary.recentWorkflows.map((item) => `  - ${item}`) : ["  - none"]),
    "- Evidence files:",
    ...(summary.evidenceFiles.length ? summary.evidenceFiles.map((item) => `  - ${item}`) : ["  - none"]),
    "- Story files:",
    ...(summary.storyFiles.length ? summary.storyFiles.map((item) => `  - ${item}`) : ["  - none"]),
  ].join("\n");
}
