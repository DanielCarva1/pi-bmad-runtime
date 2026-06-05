import * as fs from "node:fs";
import * as path from "node:path";
import type { BmadPathConfig } from "./paths.js";
import { toProjectRelative } from "./paths.js";
import { getBaselineLockFile } from "./project.js";

export interface ConfigValidationIssue {
  severity: "ok" | "warning" | "blocked";
  label: string;
  path?: string;
  message: string;
  hint?: string;
}

export function validateRuntimeConfig(cwd: string, cfg: BmadPathConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  for (const [label, target] of [
    ["output_folder", cfg.output_folder],
    ["planning_artifacts", cfg.planning_artifacts],
    ["implementation_artifacts", cfg.implementation_artifacts],
    ["project_knowledge", cfg.project_knowledge],
  ] as const) {
    issues.push({
      severity: fs.existsSync(target) ? "ok" : "warning",
      label,
      path: toProjectRelative(cwd, target),
      message: fs.existsSync(target) ? "Path exists" : "Path is missing",
      hint: fs.existsSync(target) ? undefined : "Run /bmad init or reconcile config before autonomous work.",
    });
  }

  const baselineFile = getBaselineLockFile(cwd);
  if (!fs.existsSync(baselineFile)) {
    issues.push({ severity: "warning", label: "baseline-lock", path: toProjectRelative(cwd, baselineFile), message: "Baseline lock is missing", hint: "Run /bmad init to create a guided-reconcile baseline lock." });
  } else {
    try {
      const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8")) as { planningArtifacts?: string; implementationArtifacts?: string; policy?: string };
      if (baseline.policy !== "guided-reconcile-required-for-baseline-changes") issues.push({ severity: "warning", label: "baseline-policy", path: toProjectRelative(cwd, baselineFile), message: "Baseline policy is not the guided reconcile policy." });
      else issues.push({ severity: "ok", label: "baseline-policy", path: toProjectRelative(cwd, baselineFile), message: "Guided reconcile policy active" });
    } catch {
      issues.push({ severity: "blocked", label: "baseline-lock", path: toProjectRelative(cwd, baselineFile), message: "Baseline lock is not valid JSON", hint: "Repair or recreate baseline lock with /bmad init after backup." });
    }
  }
  return issues;
}

export function formatConfigValidation(issues: ConfigValidationIssue[]): string {
  return ["Config and baseline validation:", ...issues.map((issue) => `- [${issue.severity}] ${issue.label}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}${issue.hint ? ` — ${issue.hint}` : ""}`)].join("\n");
}
