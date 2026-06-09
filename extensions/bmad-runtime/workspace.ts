import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordRuntimeEvidence } from "./evidence.js";
import { buildProjectRegistryInput, ensureProjectInitialized, type ProjectInitResult } from "./project.js";
import { DEFAULT_RUNTIME_HOME, resolveRegistryPath, upsertProjectRecord, type BmadProjectRegistry, type RegistryOperationResult, type RegistryOptions } from "./registry.js";
import { createDefaultState, loadState } from "./state.js";
import type { ProjectResolutionResult } from "./resolution.js";

export interface DedicatedWorkspaceRootResolution {
  root: string;
  source: "preference" | "default" | "flag";
}

export interface DedicatedWorkspaceInput {
  cwd: string;
  projectName: string;
  rootPreference?: string;
  rootSource?: "preference" | "flag";
  retryProjectId?: string;
  sourceResolution?: ProjectResolutionResult;
  packageRoot?: string;
  packageSpec?: string;
}

export interface DedicatedWorkspaceSuccess {
  ok: true;
  writeOccurred: boolean;
  projectId: string;
  projectName: string;
  slug: string;
  shortId: string;
  workspacePath: string;
  root: string;
  rootSource: DedicatedWorkspaceRootResolution["source"];
  created: string[];
  reused: string[];
  skipped: string[];
  touchedPaths: string[];
  registry: RegistryOperationResult<BmadProjectRegistry>;
  evidencePath?: string;
  packageSettingsPath?: string;
  packageSpec?: string;
}

export interface DedicatedWorkspaceFailure {
  ok: false;
  writeOccurred: boolean;
  projectName?: string;
  slug?: string;
  shortId?: string;
  workspacePath?: string;
  root?: string;
  rootSource?: DedicatedWorkspaceRootResolution["source"];
  created: string[];
  reused: string[];
  skipped: string[];
  touchedPaths: string[];
  registry?: RegistryOperationResult<BmadProjectRegistry>;
  recoveryAction: string;
  error: string;
  evidencePath?: string;
  packageSettingsPath?: string;
  packageSpec?: string;
}

export type DedicatedWorkspaceResult = DedicatedWorkspaceSuccess | DedicatedWorkspaceFailure;

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

export function slugProjectName(projectName: string): string {
  const trimmed = projectName.trim();
  if (!trimmed) throw new Error("Project name must not be empty.");
  if (hasControlCharacter(trimmed)) throw new Error("Project name must not contain control characters.");
  if (trimmed.includes("..")) throw new Error("Project name must not contain '..'.");
  if (trimmed.includes("/") || trimmed.includes("\\")) throw new Error("Project name must not contain path separators.");
  const slug = trimmed
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!slug) throw new Error("Project name must contain at least one ASCII letter or number.");
  return slug;
}

export function deriveShortId(projectId: string): string {
  const normalized = projectId.trim();
  if (!normalized) throw new Error("Project ID must not be empty.");
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

function readRuntimeRootPreference(runtimeHome: string): string | undefined {
  const file = path.join(runtimeHome, "preferences.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { dedicatedWorkspaceRoot?: unknown };
    return typeof parsed.dedicatedWorkspaceRoot === "string" && parsed.dedicatedWorkspaceRoot.trim()
      ? parsed.dedicatedWorkspaceRoot.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

export function resolveDedicatedWorkspaceRoot(options: { rootPreference?: string; rootSource?: "preference" | "flag"; runtimeHome?: string } = {}): DedicatedWorkspaceRootResolution {
  const rawRoot = options.rootPreference?.trim();
  if (rawRoot) return { root: path.resolve(rawRoot), source: options.rootSource ?? "preference" };
  const configured = readRuntimeRootPreference(options.runtimeHome ?? DEFAULT_RUNTIME_HOME);
  if (configured) return { root: path.resolve(configured), source: "preference" };
  return { root: path.join(os.homedir(), "bmad-projects"), source: "default" };
}

function assertPathInside(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Workspace path must stay inside dedicated root: ${child}`);
  }
}

export function buildDedicatedWorkspacePath(input: { projectName: string; projectId: string; rootPreference?: string; rootSource?: "preference" | "flag"; runtimeHome?: string }): { root: string; rootSource: DedicatedWorkspaceRootResolution["source"]; workspacePath: string; slug: string; shortId: string } {
  const slug = slugProjectName(input.projectName);
  const shortId = deriveShortId(input.projectId);
  const resolved = resolveDedicatedWorkspaceRoot({ rootPreference: input.rootPreference, rootSource: input.rootSource, runtimeHome: input.runtimeHome });
  const workspacePath = path.resolve(resolved.root, `${slug}--${shortId}`);
  assertPathInside(resolved.root, workspacePath);
  return { root: resolved.root, rootSource: resolved.source, workspacePath, slug, shortId };
}

function touchedPaths(init: Pick<ProjectInitResult, "created" | "reused" | "skipped">, extra?: string): string[] {
  return [...init.created, ...init.reused, ...init.skipped, ...(extra ? [extra] : [])];
}

function packageSpecIsRemote(spec: string): boolean {
  return /^(git|npm|https?):/i.test(spec.trim());
}

function readPackageSpecs(cwd: string): string[] {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8")) as { packages?: unknown[] };
    return (settings.packages ?? [])
      .map((entry) => typeof entry === "string" ? entry : entry && typeof entry === "object" ? String((entry as { source?: unknown }).source ?? "") : "")
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function pathSpecPointsAtPackageRoot(sourceCwd: string, spec: string, packageRoot: string): boolean {
  if (packageSpecIsRemote(spec)) return false;
  const resolved = path.isAbsolute(spec) ? path.resolve(spec) : path.resolve(sourceCwd, spec);
  try {
    return fs.existsSync(resolved) && fs.existsSync(packageRoot)
      ? fs.realpathSync.native(resolved) === fs.realpathSync.native(packageRoot)
      : path.resolve(resolved) === path.resolve(packageRoot);
  } catch {
    return path.resolve(resolved) === path.resolve(packageRoot);
  }
}

function relativePackageSpec(workspacePath: string, packageRoot: string): string {
  const relative = path.relative(workspacePath, packageRoot);
  return relative ? relative : ".";
}

function resolveDedicatedPackageSpec(input: DedicatedWorkspaceInput, workspacePath: string): string | undefined {
  if (input.packageSpec?.trim()) return input.packageSpec.trim();
  const packageRoot = input.packageRoot?.trim();
  if (!packageRoot) return undefined;
  const sourceSpecs = readPackageSpecs(input.cwd);
  const reusableRemote = sourceSpecs.find(packageSpecIsRemote);
  if (reusableRemote) return reusableRemote;
  const resolvedPackageRoot = path.resolve(packageRoot);
  const matchingLocal = sourceSpecs.find((spec) => pathSpecPointsAtPackageRoot(input.cwd, spec, resolvedPackageRoot));
  if (matchingLocal) return relativePackageSpec(workspacePath, resolvedPackageRoot);
  return relativePackageSpec(workspacePath, resolvedPackageRoot);
}

function ensureProjectLocalPackageSettings(input: DedicatedWorkspaceInput, workspacePath: string): { path: string; relativePath: string; packageSpec: string; writeOccurred: boolean } | undefined {
  const packageSpec = resolveDedicatedPackageSpec(input, workspacePath);
  if (!packageSpec) return undefined;
  const settingsFile = path.join(workspacePath, ".pi", "settings.json");
  const relativePath = path.relative(workspacePath, settingsFile).replaceAll(path.sep, "/");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
  } catch {
    settings = {};
  }
  const existingPackages = Array.isArray(settings.packages) ? settings.packages : [];
  const existingStrings = existingPackages.map((entry) => typeof entry === "string" ? entry : "");
  if (existingStrings.includes(packageSpec)) {
    return { path: settingsFile, relativePath, packageSpec, writeOccurred: false };
  }
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const next = { ...settings, packages: [...existingPackages, packageSpec] };
  fs.writeFileSync(settingsFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { path: settingsFile, relativePath, packageSpec, writeOccurred: true };
}

function stateActive(workspacePath: string): boolean {
  try {
    return loadState(workspacePath).active;
  } catch {
    return createDefaultState().active;
  }
}

function pathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertDedicatedWorkspaceBoundary(input: DedicatedWorkspaceInput, layout: ReturnType<typeof buildDedicatedWorkspacePath>): void {
  const sourceCwd = path.resolve(input.cwd);
  if (pathInside(sourceCwd, layout.workspacePath)) {
    throw new Error("Dedicated workspace must not be created inside the source cwd.");
  }
  const targetBoundary = input.sourceResolution?.boundaries.find((boundary) => boundary.label === "Target Code Repo");
  if (targetBoundary && pathInside(path.resolve(targetBoundary.path), layout.workspacePath)) {
    throw new Error("Dedicated workspace must not be created inside the Target Code Repo boundary.");
  }
  if (fs.existsSync(layout.workspacePath) && fs.lstatSync(layout.workspacePath).isSymbolicLink()) {
    throw new Error("Dedicated workspace path must not be a symbolic link.");
  }
  if (fs.existsSync(layout.root)) {
    const realRoot = fs.realpathSync.native(layout.root);
    const realWorkspace = fs.existsSync(layout.workspacePath)
      ? fs.realpathSync.native(layout.workspacePath)
      : path.resolve(realRoot, path.basename(layout.workspacePath));
    assertPathInside(realRoot, realWorkspace);
  }
}

export async function createDedicatedWorkspace(input: DedicatedWorkspaceInput, options: RegistryOptions = {}): Promise<DedicatedWorkspaceResult> {
  let projectId: string = input.retryProjectId ?? crypto.randomUUID();
  let layout: ReturnType<typeof buildDedicatedWorkspacePath>;
  try {
    layout = buildDedicatedWorkspacePath({ projectName: input.projectName, projectId, rootPreference: input.rootPreference, rootSource: input.rootSource, runtimeHome: options.runtimeHome });
    assertDedicatedWorkspaceBoundary(input, layout);
  } catch (error) {
    return { ok: false, writeOccurred: false, created: [], reused: [], skipped: [], touchedPaths: [], recoveryAction: "provide-valid-dedicated-workspace-name-or-root", error: error instanceof Error ? error.message : String(error) };
  }

  const projectName = input.projectName.trim();
  let init: ProjectInitResult = { created: [], reused: [], skipped: [], identity: undefined as never, baseline: undefined as never };
  let registry: RegistryOperationResult<BmadProjectRegistry> | undefined;
  let evidencePath: string | undefined;
  let registryPath: string | undefined;
  let packageSettings: ReturnType<typeof ensureProjectLocalPackageSettings> | undefined;
  let writeOccurredSoFar = false;

  try {
    fs.mkdirSync(layout.root, { recursive: true });
    if (fs.existsSync(layout.workspacePath) && fs.readdirSync(layout.workspacePath).length > 0) {
      return { ok: false, writeOccurred: false, projectName, slug: layout.slug, shortId: layout.shortId, workspacePath: layout.workspacePath, root: layout.root, rootSource: layout.rootSource, created: [], reused: [], skipped: [], touchedPaths: [], recoveryAction: "choose-empty-dedicated-workspace-folder-or-reconcile-existing", error: "Dedicated workspace folder already exists and is not empty." };
    }

    init = ensureProjectInitialized(layout.workspacePath, { projectId, projectName });
    projectId = init.identity.projectId;
    writeOccurredSoFar = init.created.length > 0;
    packageSettings = ensureProjectLocalPackageSettings(input, layout.workspacePath);
    writeOccurredSoFar = writeOccurredSoFar || Boolean(packageSettings?.writeOccurred);
    try {
      registryPath = resolveRegistryPath(options);
    } catch {
      registryPath = undefined;
    }
    registry = await upsertProjectRecord(buildProjectRegistryInput(layout.workspacePath, init), options);
    const writeOccurred = init.created.length > 0 || Boolean(packageSettings?.writeOccurred) || (registry.ok ? registry.writeOccurred : registry.error.writeOccurred);
    writeOccurredSoFar = writeOccurred;
    const paths = [...touchedPaths(init, registryPath), ...(packageSettings ? [packageSettings.relativePath] : [])];
    const evidence = recordRuntimeEvidence(layout.workspacePath, {
      command: "/bmad init --dedicated",
      outcome: registry.ok ? "ok" : "blocked",
      summary: registry.ok ? "Dedicated local BMAD Project Workspace created with project-local Pi package settings." : "Dedicated local workspace scaffold was created but registry update failed; project is not ready/active.",
      touchedPaths: paths,
      details: {
        sourceCwd: path.resolve(input.cwd),
        sourceResolution: input.sourceResolution ? {
          confidence: input.sourceResolution.confidence,
          reason: input.sourceResolution.reason,
          nextSafeAction: input.sourceResolution.nextSafeAction,
          recoveryAction: input.sourceResolution.recoveryAction,
          canonicalPaths: input.sourceResolution.canonicalPaths,
          boundaries: input.sourceResolution.boundaries,
          evidenceUsed: input.sourceResolution.evidenceUsed,
        } : undefined,
        root: layout.root,
        rootSource: layout.rootSource,
        workspacePath: layout.workspacePath,
        projectId,
        projectName,
        slug: layout.slug,
        shortId: layout.shortId,
        stateActive: stateActive(layout.workspacePath),
        packageSettings: packageSettings ? { path: packageSettings.relativePath, packageSpec: packageSettings.packageSpec, writeOccurred: packageSettings.writeOccurred } : { skipped: "package root/spec not available" },
        registry: registry.ok ? { ok: true, writeOccurred: registry.writeOccurred, projects: registry.value.projects.length } : { ok: false, error: registry.error },
      },
    });
    evidencePath = evidence.relativePath;

    if (!registry.ok) {
      return { ok: false, writeOccurred, projectName, slug: layout.slug, shortId: layout.shortId, workspacePath: layout.workspacePath, root: layout.root, rootSource: layout.rootSource, created: init.created, reused: init.reused, skipped: init.skipped, touchedPaths: [...paths, evidence.relativePath], registry, recoveryAction: registry.error.recoveryAction.action, error: registry.error.message, evidencePath, packageSettingsPath: packageSettings?.relativePath, packageSpec: packageSettings?.packageSpec };
    }

    return { ok: true, writeOccurred, projectId, projectName, slug: layout.slug, shortId: layout.shortId, workspacePath: layout.workspacePath, root: layout.root, rootSource: layout.rootSource, created: init.created, reused: init.reused, skipped: init.skipped, touchedPaths: [...paths, evidence.relativePath], registry, evidencePath, packageSettingsPath: packageSettings?.relativePath, packageSpec: packageSettings?.packageSpec };
  } catch (error) {
    return { ok: false, writeOccurred: writeOccurredSoFar, projectName, slug: layout.slug, shortId: layout.shortId, workspacePath: layout.workspacePath, root: layout.root, rootSource: layout.rootSource, created: init.created, reused: init.reused, skipped: init.skipped, touchedPaths: [...touchedPaths(init, registryPath), ...(packageSettings ? [packageSettings.relativePath] : [])], registry, recoveryAction: "inspect-partial-dedicated-workspace-and-retry", error: error instanceof Error ? error.message : String(error), evidencePath, packageSettingsPath: packageSettings?.relativePath, packageSpec: packageSettings?.packageSpec };
  }
}

export function formatDedicatedWorkspaceResult(result: DedicatedWorkspaceResult): string {
  const lines = [
    "# Dedicated Local Project Workspace",
    "",
    `OK: ${result.ok}`,
    `Write occurred: ${result.writeOccurred}`,
    `Project: ${result.projectName ?? "unknown"}`,
    `Workspace path: ${result.workspacePath ?? "not-created"}`,
    `Root: ${result.root ?? "not-resolved"}`,
    `Root source: ${result.rootSource ?? "unknown"}`,
    `Project ID: ${result.ok ? result.projectId : "not-ready"}`,
    `Package settings: ${result.packageSettingsPath ?? "not configured"}`,
    `Package spec: ${result.packageSpec ?? "not configured"}`,
    `Evidence: ${result.evidencePath ?? "none"}`,
    "",
    "Touched paths:",
    ...(result.touchedPaths.length > 0 ? result.touchedPaths.map((item) => `- ${item}`) : ["- none"]),
  ];
  if (!result.ok) lines.push("", `Recovery: ${result.recoveryAction}`, `Error: ${result.error}`, "Project ready/active: false");
  else lines.push("", `Registry projects: ${result.registry.ok ? result.registry.value.projects.length : "unknown"}`, "Remote/push/publication: not performed");
  return lines.join("\n");
}
