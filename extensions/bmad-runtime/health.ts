import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBmadCatalog } from "./catalog.js";
import { scanOfficialBmadModules } from "./modules.js";
import { loadPathConfig, toProjectRelative } from "./paths.js";
import { getBaselineLockFile, getProjectIdentityFile } from "./project.js";
import { getStateFile } from "./state.js";

export type HealthSeverity = "ok" | "warning" | "degraded" | "blocked";

export interface HealthFinding {
  severity: HealthSeverity;
  label: string;
  detail: string;
  path?: string;
  hint?: string;
}

export interface HealthReport {
  generatedAt: string;
  packageRoot: string;
  packageVersion?: string;
  findings: HealthFinding[];
  counts: Record<HealthSeverity, number>;
}

export const RECOMMENDED_PACKAGES = [
  "pi-goal-x",
  "@gotgenes/pi-subagents",
  "pi-safety-modes",
  "pi-show-diffs",
  "pi-resource-center",
  "pi-studio",
  "@plannotator/pi-extension",
  "pi-powerline-footer",
];

function packageRootFromImportMeta(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function add(findings: HealthFinding[], finding: HealthFinding): void {
  findings.push(finding);
}

function existsFinding(cwd: string, findings: HealthFinding[], file: string, label: string, missingSeverity: HealthSeverity, hint: string): void {
  const rel = toProjectRelative(cwd, file);
  if (fs.existsSync(file)) add(findings, { severity: "ok", label, detail: "Found", path: rel });
  else add(findings, { severity: missingSeverity, label, detail: "Missing", path: rel, hint });
}

function packageSpecsFromSettings(cwd: string): string[] {
  const settings = readJson<{ packages?: unknown[] }>(path.join(cwd, ".pi", "settings.json"));
  if (!settings || !Array.isArray(settings.packages)) return [];
  return settings.packages
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string") return (entry as { source: string }).source;
      return "";
    })
    .filter(Boolean);
}

function hasPackage(specs: string[], packageName: string): boolean {
  return specs.some((spec) => spec === packageName || spec.includes(`:${packageName}`) || spec.includes(packageName));
}

export function runHealthCheck(cwd: string, packageRoot = packageRootFromImportMeta()): HealthReport {
  const findings: HealthFinding[] = [];
  const pkgFile = path.join(packageRoot, "package.json");
  const pkg = readJson<{ version?: string; name?: string; pi?: unknown }>(pkgFile);
  if (pkg) {
    add(findings, { severity: "ok", label: "Runtime package", detail: `${pkg.name ?? "unknown"}@${pkg.version ?? "unknown"}`, path: pkgFile });
    add(findings, { severity: pkg.pi ? "ok" : "blocked", label: "Pi package manifest", detail: pkg.pi ? "Declared" : "Missing", path: pkgFile, hint: pkg.pi ? undefined : "Add a package.json pi manifest." });
  } else {
    add(findings, { severity: "blocked", label: "Runtime package", detail: "package.json not found", path: pkgFile, hint: "Verify package installation/source path." });
  }

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  add(findings, {
    severity: nodeMajor >= 22 ? "ok" : "blocked",
    label: "Node support",
    detail: `Node ${process.versions.node}`,
    hint: nodeMajor >= 22 ? undefined : "Use Node.js 22 or newer for this runtime.",
  });

  const cfg = loadPathConfig(cwd);
  const catalog = loadBmadCatalog(cwd);
  if (!catalog.exists) add(findings, { severity: "blocked", label: "BMAD catalog", detail: "Missing bmad-help.csv", path: toProjectRelative(cwd, catalog.path), hint: "Install or reconcile BMAD config before workflow routing." });
  else if (catalog.error) add(findings, { severity: "blocked", label: "BMAD catalog", detail: catalog.error, path: toProjectRelative(cwd, catalog.path), hint: "Fix catalog parse error." });
  else add(findings, { severity: catalog.rows.length > 0 ? "ok" : "warning", label: "BMAD catalog", detail: `${catalog.rows.length} rows`, path: toProjectRelative(cwd, catalog.path), hint: catalog.rows.length > 0 ? undefined : "Catalog is empty; reinstall/reconcile BMAD config." });

  existsFinding(cwd, findings, path.join(cwd, "_bmad", "_config", "manifest.yaml"), "BMAD manifest", "warning", "Reinstall or reconcile BMAD manifest.");
  for (const moduleStatus of scanOfficialBmadModules(cwd)) {
    add(findings, {
      severity: moduleStatus.present ? "ok" : "warning",
      label: `Official BMAD module: ${moduleStatus.module}`,
      detail: moduleStatus.present ? `Found (${moduleStatus.evidence.join(", ")})` : "Missing",
      path: moduleStatus.evidence[0] ?? `_bmad/${moduleStatus.module}`,
      hint: moduleStatus.hint,
    });
  }
  existsFinding(cwd, findings, getStateFile(cwd), "Runtime state", "warning", "Run /bmad init to create runtime state.");
  existsFinding(cwd, findings, getProjectIdentityFile(cwd), "Project identity", "warning", "Run /bmad init to create project identity.");
  existsFinding(cwd, findings, getBaselineLockFile(cwd), "Baseline lock", "warning", "Run /bmad init to create baseline lock.");

  for (const [label, dir] of [
    ["Output folder", cfg.output_folder],
    ["Planning artifacts", cfg.planning_artifacts],
    ["Implementation artifacts", cfg.implementation_artifacts],
    ["Project knowledge", cfg.project_knowledge],
  ] as const) {
    if (fs.existsSync(dir)) add(findings, { severity: "ok", label, detail: "Found", path: toProjectRelative(cwd, dir) });
    else add(findings, { severity: "warning", label, detail: "Missing", path: toProjectRelative(cwd, dir), hint: "Run /bmad init to create missing project folders." });
  }

  const agentsDir = path.join(cwd, ".pi", "agents");
  if (fs.existsSync(agentsDir)) add(findings, { severity: "ok", label: "Project agents", detail: "Found", path: toProjectRelative(cwd, agentsDir) });
  else add(findings, { severity: "warning", label: "Project agents", detail: "Missing", path: toProjectRelative(cwd, agentsDir), hint: "Add project agents if agent roster support is required." });

  const packageSpecs = packageSpecsFromSettings(cwd);
  if (packageSpecs.length === 0) add(findings, { severity: "degraded", label: "Recommended package adapters", detail: "No .pi/settings.json packages detected", path: ".pi/settings.json", hint: "Install recommended UX packages or continue in text/TUI degraded mode." });
  for (const packageName of RECOMMENDED_PACKAGES) {
    const present = hasPackage(packageSpecs, packageName);
    add(findings, {
      severity: present ? "ok" : "degraded",
      label: `Adapter package: ${packageName}`,
      detail: present ? "Configured" : "Not configured",
      path: ".pi/settings.json",
      hint: present ? undefined : "Optional UX adapter missing; BMAD core remains available in degraded text/TUI mode.",
    });
  }

  const counts: Record<HealthSeverity, number> = { ok: 0, warning: 0, degraded: 0, blocked: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return { generatedAt: new Date().toISOString(), packageRoot, packageVersion: pkg?.version, findings, counts };
}

export function formatHealthReport(report: HealthReport): string {
  const lines = [
    "# BMAD Runtime Health",
    "",
    `Generated: ${report.generatedAt}`,
    `Package root: ${report.packageRoot}`,
    report.packageVersion ? `Package version: ${report.packageVersion}` : "Package version: unknown",
    `Summary: ok=${report.counts.ok}, warning=${report.counts.warning}, degraded=${report.counts.degraded}, blocked=${report.counts.blocked}`,
    "",
  ];
  for (const finding of report.findings) {
    const pathText = finding.path ? ` (${finding.path})` : "";
    lines.push(`- [${finding.severity}] ${finding.label}: ${finding.detail}${pathText}`);
    if (finding.hint) lines.push(`  - Hint: ${finding.hint}`);
  }
  return lines.join("\n");
}
