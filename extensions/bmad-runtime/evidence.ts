import * as fs from "node:fs";
import * as path from "node:path";
import { loadPathConfig, toProjectRelative } from "./paths.js";

export interface RuntimeEvidencePayload {
  command: string;
  outcome: "ok" | "warning" | "degraded" | "blocked" | "error";
  summary: string;
  packageVersion?: string;
  touchedPaths?: string[];
  counts?: Record<string, number>;
  details?: unknown;
}

export interface RuntimeEvidenceResult {
  absolutePath: string;
  relativePath: string;
}

function formatPayload(payload: RuntimeEvidencePayload): string {
  const lines = [
    `## ${new Date().toISOString()} — ${payload.command}`,
    "",
    `- Outcome: ${payload.outcome}`,
    `- Summary: ${payload.summary}`,
  ];
  if (payload.packageVersion) lines.push(`- Package version: ${payload.packageVersion}`);
  if (payload.touchedPaths?.length) {
    lines.push("- Touched paths:");
    for (const touchedPath of payload.touchedPaths) lines.push(`  - ${touchedPath}`);
  }
  if (payload.counts) {
    lines.push("- Counts:");
    for (const [key, value] of Object.entries(payload.counts)) lines.push(`  - ${key}: ${value}`);
  }
  if (payload.details !== undefined) {
    lines.push("", "```json", JSON.stringify(payload.details, null, 2), "```");
  }
  lines.push("");
  return lines.join("\n");
}

export function recordRuntimeEvidence(cwd: string, payload: RuntimeEvidencePayload): RuntimeEvidenceResult {
  const cfg = loadPathConfig(cwd);
  const evidenceDir = path.join(cfg.output_folder, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidenceFile = path.join(evidenceDir, "bmad-runtime-command-evidence.md");
  if (!fs.existsSync(evidenceFile)) {
    fs.writeFileSync(evidenceFile, "# BMAD Runtime Command Evidence\n\n", "utf8");
  }
  fs.appendFileSync(evidenceFile, formatPayload(payload), "utf8");
  return { absolutePath: evidenceFile, relativePath: toProjectRelative(cwd, evidenceFile) };
}
