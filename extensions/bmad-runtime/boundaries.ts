import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RUNTIME_HOME, resolveRegistryPath, type RegistryOptions } from "./registry.js";
import { loadPathConfig, toProjectRelative } from "./paths.js";

export type RuntimeBoundaryLabel =
  | "Runtime Package"
  | "Runtime Home"
  | "Project Workspace"
  | "Target Code Repo";

export interface RuntimeBoundary {
  label: RuntimeBoundaryLabel;
  path: string;
  responsibility: string;
  writePolicy: string;
}

export interface RuntimeBoundaryOptions extends RegistryOptions {
  packageRoot?: string;
  targetCodeRepo?: string;
}

export function defaultRuntimePackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function defaultTargetCodeRepo(cwd: string): string {
  return path.resolve(cwd, "..", "pi-bmad-runtime");
}

export function describeRuntimeBoundaries(
  cwd: string,
  options: RuntimeBoundaryOptions = {},
): RuntimeBoundary[] {
  const projectWorkspace = path.resolve(cwd);
  const cfg = loadPathConfig(projectWorkspace);
  const registryPath = resolveRegistryPath(options);
  const runtimeHome = path.dirname(registryPath);
  const packageRoot = path.resolve(options.packageRoot ?? defaultRuntimePackageRoot());
  const targetCodeRepo = path.resolve(options.targetCodeRepo ?? defaultTargetCodeRepo(projectWorkspace));

  return [
    {
      label: "Runtime Package",
      path: packageRoot,
      responsibility: "Pi extension/runtime source, package-local skills, prompts and docs.",
      writePolicy: "Package code changes only through scoped Phase 4 stories; never store project-owned canonical artifacts here.",
    },
    {
      label: "Runtime Home",
      path: runtimeHome || DEFAULT_RUNTIME_HOME,
      responsibility: `Operational metadata/cache/locks/sessions; registry file: ${registryPath}.`,
      writePolicy: "Operational metadata only; PRD, architecture, epics, stories and evidence remain outside Runtime Home.",
    },
    {
      label: "Project Workspace",
      path: projectWorkspace,
      responsibility: `Canonical BMAD artifacts/state/evidence; output folder: ${cfg.output_folder}.`,
      writePolicy: "Project-owned artifacts, .bmad-runtime state and evidence are written here in readable Markdown/YAML/JSON.",
    },
    {
      label: "Target Code Repo",
      path: targetCodeRepo,
      responsibility: "Product/runtime code under implementation during Phase 4 self-improvement.",
      writePolicy: "Read-only in Phase 3; writes only via scoped Phase 4 story allowed paths with checks and review evidence.",
    },
  ];
}

export function formatRuntimeBoundaries(
  boundaries: RuntimeBoundary[],
  cwd?: string,
): string {
  const lines = ["# Runtime Boundaries", ""];
  for (const boundary of boundaries) {
    const displayPath = cwd ? toProjectRelative(cwd, boundary.path) : boundary.path;
    lines.push(`- **${boundary.label}**: ${displayPath}`);
    lines.push(`  - Responsibility: ${boundary.responsibility}`);
    lines.push(`  - Write policy: ${boundary.writePolicy}`);
  }
  return lines.join("\n");
}

