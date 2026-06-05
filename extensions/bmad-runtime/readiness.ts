import * as fs from "node:fs";
import * as path from "node:path";
import type { ArtifactRegistryEntry } from "./artifacts.js";
import type { BmadPathConfig } from "./paths.js";
import { toProjectRelative } from "./paths.js";

export type ReadinessDecision = "pass" | "blocked" | "waived" | "missing";

export interface ReadinessGateResult {
  decision: ReadinessDecision;
  implementationMayStart: boolean;
  reportPath: string;
  requiredArtifacts: ArtifactRegistryEntry[];
  missingArtifacts: ArtifactRegistryEntry[];
  blockers: string[];
  waiver?: {
    scope?: string;
    reason?: string;
  };
}

function readIfExists(file: string): string {
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8");
}

export function evaluateReadinessGate(cfg: BmadPathConfig, artifacts: ArtifactRegistryEntry[]): ReadinessGateResult {
  const report = path.join(cfg.output_folder, "planning-artifacts", "implementation-readiness-report-2026-05-29.md");
  const reportText = readIfExists(report);
  const requiredArtifacts = artifacts.filter((entry) => entry.requiredForReadiness);
  const missingArtifacts = requiredArtifacts.filter((entry) => entry.status === "missing");
  const blockers: string[] = [];
  if (missingArtifacts.length > 0) blockers.push(`Missing readiness artifacts: ${missingArtifacts.map((entry) => entry.id).join(", ")}.`);
  if (!reportText) blockers.push("Implementation readiness report is missing.");

  const lower = reportText.toLowerCase();
  const explicitPass = /readinessdecision:\s*"?pass"?/i.test(reportText) || lower.includes("overall status:** ready") || lower.includes("decision:** phase 4 implementation may start");
  const explicitWaiver = /readinessdecision:\s*"?waiv/i.test(reportText) || lower.includes("waiver required") || lower.includes("waived");
  const explicitBlocked = /readinessdecision:\s*"?blocked"?/i.test(reportText) || lower.includes("not ready") || lower.includes("critical issues requiring immediate action\n\nnone") === false && lower.includes("critical issues");

  let decision: ReadinessDecision = "missing";
  if (explicitPass && missingArtifacts.length === 0) decision = "pass";
  else if (explicitWaiver && missingArtifacts.length === 0) decision = "waived";
  else if (explicitBlocked || blockers.length > 0) decision = "blocked";

  return {
    decision,
    implementationMayStart: decision === "pass" || decision === "waived",
    reportPath: toProjectRelative(cfg.projectRoot, report),
    requiredArtifacts,
    missingArtifacts,
    blockers,
    waiver: decision === "waived" ? { reason: "Recorded readiness waiver detected in report." } : undefined,
  };
}

export function formatGateCard(result: ReadinessGateResult): string {
  const lines = [
    "Implementation readiness gate:",
    `- Decision: ${result.decision}`,
    `- Phase 4 allowed: ${result.implementationMayStart ? "yes" : "no"}`,
    `- Report: ${result.reportPath}`,
    "- Required artifacts:",
    ...result.requiredArtifacts.map((entry) => `  - [${entry.status}] ${entry.label}: ${entry.path}`),
  ];
  if (result.blockers.length > 0) {
    lines.push("- Blockers:");
    for (const blocker of result.blockers) lines.push(`  - ${blocker}`);
  }
  if (result.waiver) lines.push(`- Waiver: ${result.waiver.reason ?? "recorded"}`);
  return lines.join("\n");
}
