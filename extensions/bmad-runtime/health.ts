import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describeRuntimeBoundaries, type RuntimeBoundary } from "./boundaries.js";
import { loadBmadCatalog } from "./catalog.js";
import { scanOfficialBmadModules } from "./modules.js";
import { loadPathConfig, toProjectRelative } from "./paths.js";
import { getBaselineLockFile, getProjectIdentityFile, readGitEvidence } from "./project.js";
import { REGISTRY_SCHEMA_VERSION, resolveRegistryPath, type RegistryOptions } from "./registry.js";
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
  registryPath: string;
  boundaries: RuntimeBoundary[];
  findings: HealthFinding[];
  counts: Record<HealthSeverity, number>;
}

export interface HealthCheckOptions extends RegistryOptions {
  targetCodeRepo?: string;
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

function recovery(severity: HealthSeverity, hint: string | undefined): string | undefined {
  return severity === "ok" ? undefined : hint;
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

function registryDiagnostics(cwd: string, findings: HealthFinding[], options: RegistryOptions): string {
  let registryPath: string;
  try {
    registryPath = resolveRegistryPath(options);
  } catch (error) {
    add(findings, {
      severity: "blocked",
      label: "Registry path",
      detail: error instanceof Error ? error.message : String(error),
      hint: "Provide a non-empty Runtime Home or registry path.",
    });
    return "unresolved";
  }

  const runtimeHome = path.dirname(registryPath);
  add(findings, {
    severity: fs.existsSync(runtimeHome) ? "ok" : "warning",
    label: "Runtime Home directory",
    detail: fs.existsSync(runtimeHome) ? "Found" : "Missing",
    path: toProjectRelative(cwd, runtimeHome),
    hint: fs.existsSync(runtimeHome) ? undefined : "Run /bmad-start to select/create a project, or use /bmad init only for explicit repair.",
  });

  if (!fs.existsSync(registryPath)) {
    add(findings, {
      severity: "warning",
      label: "Registry schema",
      detail: "Registry file missing",
      path: toProjectRelative(cwd, registryPath),
      hint: "Create registry through /bmad-start in the intended BMAD workspace; use /bmad init only for explicit repair.",
    });
    return registryPath;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch {
    add(findings, {
      severity: "blocked",
      label: "Registry schema",
      detail: "Registry JSON is invalid",
      path: toProjectRelative(cwd, registryPath),
      hint: "Repair JSON or restore registry from backup before project resolution/resume.",
    });
    return registryPath;
  }

  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as { schemaVersion?: unknown; projects?: unknown }
    : undefined;
  if (!root) {
    add(findings, {
      severity: "blocked",
      label: "Registry schema",
      detail: "Registry root is not an object",
      path: toProjectRelative(cwd, registryPath),
      hint: "Replace registry with supported metadata-only schema.",
    });
    return registryPath;
  }
  if (root.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    add(findings, {
      severity: "blocked",
      label: "Registry migration",
      detail: `Unsupported schemaVersion '${String(root.schemaVersion)}'`,
      path: toProjectRelative(cwd, registryPath),
      hint: `Run supported migration to schemaVersion ${REGISTRY_SCHEMA_VERSION} before resume/start.`,
    });
    return registryPath;
  }
  if (!Array.isArray(root.projects)) {
    add(findings, {
      severity: "blocked",
      label: "Registry schema",
      detail: "projects must be an array",
      path: toProjectRelative(cwd, registryPath),
      hint: "Repair registry shape before project resolution/resume.",
    });
    return registryPath;
  }
  add(findings, {
    severity: "ok",
    label: "Registry schema",
    detail: `schemaVersion=${REGISTRY_SCHEMA_VERSION}; projects=${root.projects.length}`,
    path: toProjectRelative(cwd, registryPath),
  });
  add(findings, {
    severity: "ok",
    label: "Registry migration",
    detail: "No migration required",
    path: toProjectRelative(cwd, registryPath),
  });
  return registryPath;
}

function lockDiagnostics(cwd: string, findings: HealthFinding[], registryPath: string): void {
  for (const [label, lockFile] of [
    ["Registry lock", registryPath === "unresolved" ? "" : `${registryPath}.lock`],
    ["Runtime state lock", `${getStateFile(cwd)}.lock`],
  ] as const) {
    if (!lockFile) continue;
    const present = fs.existsSync(lockFile);
    add(findings, {
      severity: present ? "warning" : "ok",
      label,
      detail: present ? "Lock file present" : "No lock file present",
      path: toProjectRelative(cwd, lockFile),
      hint: present ? "Confirm no active writer is running; remove stale lock only after manual verification." : undefined,
    });
  }
}

function gitDiagnostics(cwd: string, findings: HealthFinding[]): void {
  const git = readGitEvidence(cwd);
  if (!git) {
    add(findings, {
      severity: "warning",
      label: "Git evidence",
      detail: "No git worktree evidence found",
      hint: "Use a git worktree for stronger resume/publication evidence, or continue local-only intentionally.",
    });
    return;
  }
  const parts = [
    git.branch ? `branch=${git.branch}` : undefined,
    git.commit ? `commit=${git.commit}` : undefined,
    git.remoteUrlFingerprint ? `remoteFingerprint=${git.remoteUrlFingerprint}` : undefined,
  ].filter((item): item is string => !!item);
  add(findings, {
    severity: "ok",
    label: "Git evidence",
    detail: parts.join("; ") || "worktree detected",
    path: git.worktreePath ? toProjectRelative(cwd, git.worktreePath) : undefined,
  });
}

function smokeDiagnostics(cwd: string, packageRoot: string, findings: HealthFinding[]): void {
  const pkg = readJson<{ scripts?: Record<string, string> }>(path.join(packageRoot, "package.json"));
  const scripts = pkg?.scripts ?? {};
  for (const [script, label] of [
    ["test", "Smoke command: npm test"],
    ["pack:dry-run", "Smoke command: npm run pack:dry-run"],
  ] as const) {
    const present = typeof scripts[script] === "string" && scripts[script]!.trim().length > 0;
    add(findings, {
      severity: present ? "ok" : "warning",
      label,
      detail: present ? scripts[script]! : "Missing package script",
      path: toProjectRelative(cwd, path.join(packageRoot, "package.json")),
      hint: present ? undefined : `Add package script '${script}' or document equivalent smoke check.`,
    });
  }
  const preflight = path.join(cwd, "scripts", "pi_bmad_preflight.py");
  add(findings, {
    severity: fs.existsSync(preflight) ? "ok" : "warning",
    label: "Project preflight availability",
    detail: fs.existsSync(preflight) ? "Found" : "Missing",
    path: toProjectRelative(cwd, preflight),
    hint: fs.existsSync(preflight) ? undefined : "Add a local preflight script or rely on package health/status diagnostics.",
  });
}

export function runHealthCheck(cwd: string, packageRoot = packageRootFromImportMeta(), options: HealthCheckOptions = {}): HealthReport {
  const findings: HealthFinding[] = [];
  const registryPath = registryDiagnostics(cwd, findings, options);
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
  const boundaries = describeRuntimeBoundaries(cwd, { packageRoot, ...options });
  for (const boundary of boundaries) {
    const exists = fs.existsSync(boundary.path);
    add(findings, {
      severity: exists ? "ok" : "warning",
      label: boundary.label,
      detail: boundary.responsibility,
      path: toProjectRelative(cwd, boundary.path),
      hint: recovery(exists ? "ok" : "warning", `${boundary.writePolicy} Path is not present yet.`),
    });
  }
  add(findings, {
    severity: "ok",
    label: "Path normalization",
    detail: `projectWorkspace=${path.resolve(cwd)}; registry=${registryPath}`,
  });
  gitDiagnostics(cwd, findings);
  lockDiagnostics(cwd, findings, registryPath);
  smokeDiagnostics(cwd, packageRoot, findings);

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
  existsFinding(cwd, findings, getStateFile(cwd), "Runtime state", "warning", "Run /bmad-start to select/create a project; use /bmad init only for explicit repair.");
  existsFinding(cwd, findings, getProjectIdentityFile(cwd), "Project identity", "warning", "Run /bmad-start to select/create a project; use /bmad init only for explicit repair.");
  existsFinding(cwd, findings, getBaselineLockFile(cwd), "Baseline lock", "warning", "Run /bmad-start to select/create a project; use /bmad init only for explicit repair.");

  for (const [label, dir] of [
    ["Output folder", cfg.output_folder],
    ["Planning artifacts", cfg.planning_artifacts],
    ["Implementation artifacts", cfg.implementation_artifacts],
    ["Project knowledge", cfg.project_knowledge],
  ] as const) {
    if (fs.existsSync(dir)) add(findings, { severity: "ok", label, detail: "Found", path: toProjectRelative(cwd, dir) });
    else add(findings, { severity: "warning", label, detail: "Missing", path: toProjectRelative(cwd, dir), hint: "Run /bmad-start to select/create a project; use /bmad init only for explicit repair." });
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
  return { generatedAt: new Date().toISOString(), packageRoot, packageVersion: pkg?.version, registryPath, boundaries, findings, counts };
}

export function formatHealthReport(report: HealthReport): string {
  const lines = [
    "# BMAD Runtime Health",
    "",
    `Generated: ${report.generatedAt}`,
    `Package root: ${report.packageRoot}`,
    `Registry: ${report.registryPath}`,
    report.packageVersion ? `Package version: ${report.packageVersion}` : "Package version: unknown",
    `Summary: ok=${report.counts.ok}, warning=${report.counts.warning}, degraded=${report.counts.degraded}, blocked=${report.counts.blocked}`,
    "",
    "## Runtime Boundaries",
    "",
  ];
  for (const boundary of report.boundaries) {
    lines.push(`- ${boundary.label}: ${boundary.path}`);
    lines.push(`  - Responsibility: ${boundary.responsibility}`);
    lines.push(`  - Write policy: ${boundary.writePolicy}`);
  }
  lines.push("", "## Findings", "");
  for (const finding of report.findings) {
    const pathText = finding.path ? ` (${finding.path})` : "";
    lines.push(`- [${finding.severity}] ${finding.label}: ${finding.detail}${pathText}`);
    if (finding.hint) lines.push(`  - ${finding.severity === "ok" ? "Hint" : "Recovery"}: ${finding.hint}`);
  }
  return lines.join("\n");
}
