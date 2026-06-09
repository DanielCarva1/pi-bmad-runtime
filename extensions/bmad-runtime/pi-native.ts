import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FUTURE_ADAPTER_BOUNDARIES } from "./future-adapters.js";
import { loadPathConfig, toProjectRelative } from "./paths.js";

export interface PiNativeCheck {
  label: string;
  ok: boolean;
  detail: string;
  path?: string;
}

export interface PiNativeSmokeReport {
  checks: PiNativeCheck[];
  evidencePath?: string;
}

function readJson(file: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function piConfig(packageJson: Record<string, unknown> | undefined): Record<string, unknown> {
  const raw = packageJson?.pi;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function packageFileExists(packageRoot: string, rel: string): boolean {
  return fs.existsSync(path.resolve(packageRoot, rel.replace(/^\.\//, "")));
}

function checkPackageFile(packageRoot: string, label: string, rel: string): PiNativeCheck {
  const file = path.resolve(packageRoot, rel.replace(/^\.\//, ""));
  return {
    label,
    ok: fs.existsSync(file),
    detail: fs.existsSync(file) ? "Package resource exists." : "Package resource is missing.",
    path: rel,
  };
}

export function validatePiNativePackage(packageRoot: string): PiNativeCheck[] {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = readJson(packageJsonPath);
  const pi = piConfig(packageJson);
  const extensions = stringArray(pi.extensions);
  const skills = stringArray(pi.skills);
  const prompts = stringArray(pi.prompts);
  const futureOnly = FUTURE_ADAPTER_BOUNDARIES.every((adapter) => adapter.v02Supported === false);

  return [
    {
      label: "package-json",
      ok: !!packageJson,
      detail: packageJson ? "package.json parsed." : "package.json missing or invalid.",
      path: "package.json",
    },
    {
      label: "pi-extension-entry",
      ok: extensions.includes("./extensions/bmad-runtime/index.ts") && packageFileExists(packageRoot, "./extensions/bmad-runtime/index.ts"),
      detail: "Pi extension entrypoint remains registered in package manifest.",
      path: "./extensions/bmad-runtime/index.ts",
    },
    {
      label: "pi-skills-entry",
      ok: skills.includes("./skills") && packageFileExists(packageRoot, "./skills/bmad-runtime-for-pi/SKILL.md"),
      detail: "Pi skills directory and BMAD runtime skill remain packaged.",
      path: "./skills/bmad-runtime-for-pi/SKILL.md",
    },
    {
      label: "pi-prompts-entry",
      ok: prompts.includes("./prompts") && packageFileExists(packageRoot, "./prompts/bmad-automation.md"),
      detail: "Pi prompts directory and BMAD automation prompt remain packaged.",
      path: "./prompts/bmad-automation.md",
    },
    checkPackageFile(packageRoot, "grill-skill", "./skills/grill-with-docs/SKILL.md"),
    {
      label: "external-adapters-future-only",
      ok: futureOnly,
      detail: "External adapters remain future-feasibility-only and do not replace Pi-native P0.",
    },
  ];
}

export function runPiNativeP0Smoke(cwd: string): PiNativeSmokeReport {
  const checks: PiNativeCheck[] = [];
  const root = path.resolve(cwd);
  const normalized = path.normalize(path.join(root, "nested", "..", "artifact-root"));
  checks.push({
    label: "path-normalization",
    ok: normalized.endsWith("artifact-root") && !normalized.includes(`..${path.sep}`),
    detail: `Normalized local path: ${normalized}`,
    path: normalized,
  });

  const command = spawnSync(process.execPath, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  checks.push({
    label: "command-execution",
    ok: command.status === 0 && String(command.stdout).trim().startsWith("v"),
    detail: command.status === 0 ? `Node command executed: ${String(command.stdout).trim()}` : `Node command failed: ${command.stderr || command.error?.message || "unknown"}`,
  });

  const cfg = loadPathConfig(root);
  const evidenceDir = path.join(cfg.output_folder, "evidence");
  const evidenceFile = path.join(evidenceDir, "pi-native-p0-smoke.md");
  try {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(evidenceFile, "# Pi-native P0 smoke\n\nartifact read/write ok\n", "utf8");
    const readBack = fs.readFileSync(evidenceFile, "utf8");
    checks.push({
      label: "artifact-read-write",
      ok: readBack.includes("artifact read/write ok"),
      detail: "Project-owned evidence artifact was written and read back.",
      path: toProjectRelative(root, evidenceFile),
    });
  } catch (error) {
    checks.push({
      label: "artifact-read-write",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      path: toProjectRelative(root, evidenceFile),
    });
  }

  return {
    checks,
    evidencePath: fs.existsSync(evidenceFile) ? toProjectRelative(root, evidenceFile) : undefined,
  };
}
