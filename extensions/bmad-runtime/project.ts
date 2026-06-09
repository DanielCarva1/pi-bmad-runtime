import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadPathConfig, toProjectRelative } from "./paths.js";
import {
  type BmadProjectRegistry,
  type GitEvidence,
  type ProjectRegistryInput,
  type ProjectPathAliasResult,
  type ProjectRegistryRecord,
  type ProjectRenameResult,
  type RegistryOperationResult,
  type RegistryOptions,
  addProjectPathAlias,
  checkProjectDisplayNameAvailable,
  loadRegistry,
  renameProjectDisplayName,
  upsertProjectRecord,
} from "./registry.js";
import { createDefaultState, getStateDir, getStateFile } from "./state.js";

export interface ProjectIdentity {
  version: 1;
  projectId: string;
  projectName: string;
  createdAt: string;
  rootFingerprint: {
    initialPath: string;
    gitRemoteFingerprint?: string;
    bmadOutputRoot: string;
  };
  clonePolicy: "new-id-by-default";
}

export interface BaselineLock {
  version: 1;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  runtimeStateVersion: 1;
  bmadCatalogPath: string;
  outputFolder: string;
  planningArtifacts: string;
  implementationArtifacts: string;
  policy: "guided-reconcile-required-for-baseline-changes";
}

export interface ProjectInitOptions {
  projectId?: string;
  projectName?: string;
}

export interface ProjectInitResult {
  created: string[];
  reused: string[];
  skipped: string[];
  identity: ProjectIdentity;
  baseline: BaselineLock;
}

export interface ProjectRegistrationResult extends ProjectInitResult {
  registry: RegistryOperationResult<BmadProjectRegistry>;
}

export interface RegisteredProjectRenameResult {
  initialization: ProjectRegistrationResult;
  registry: ProjectRenameResult;
  identity?: ProjectIdentity;
}

export interface PhysicalFolderRenameOptions extends RegistryOptions {
  explicitConfirmation?: boolean;
}

export interface PhysicalFolderRenameCheck {
  label: string;
  ok: boolean;
  detail: string;
  path?: string;
}

export interface PhysicalFolderRenamePreflightSuccess {
  ok: true;
  writeOccurred: false;
  projectId: string;
  displayName: string;
  currentWorkspacePath: string;
  requestedFolderName: string;
  targetWorkspacePath: string;
  artifactRoot: string;
  runtimeStatePath: string;
  checks: PhysicalFolderRenameCheck[];
  nextSafeAction: string;
}

export interface PhysicalFolderRenamePreflightFailure {
  ok: false;
  writeOccurred: boolean;
  projectId?: string;
  displayName?: string;
  currentWorkspacePath: string;
  requestedFolderName: string;
  targetWorkspacePath?: string;
  checks: PhysicalFolderRenameCheck[];
  recoveryAction: string;
  error: string;
}

export type PhysicalFolderRenamePreflightResult =
  | PhysicalFolderRenamePreflightSuccess
  | PhysicalFolderRenamePreflightFailure;

export interface ProjectPathAliasOptions extends RegistryOptions {
  knownRoot?: boolean;
}

export interface CurrentProjectPathAliasResult {
  initialization?: ProjectRegistrationResult;
  registry: ProjectPathAliasResult;
}

export const PROJECT_IDENTITY_FILE = "project-identity.json";
export const BASELINE_LOCK_FILE = "baseline-lock.json";

function nowIso(): string {
  return new Date().toISOString();
}

function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureDir(dir: string, result: Pick<ProjectInitResult, "created" | "reused">, cwd: string): void {
  const rel = toProjectRelative(cwd, dir);
  if (fs.existsSync(dir)) {
    result.reused.push(rel);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  result.created.push(rel);
}

function readSmallTextFile(file: string, maxBytes = 1024 * 1024): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

interface GitLocation {
  gitDir: string;
  worktreePath: string;
}

function resolveGitDirAt(worktreePath: string): string | undefined {
  const gitPath = path.join(worktreePath, ".git");
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) return gitPath;
    if (!stat.isFile()) return undefined;
  } catch {
    return undefined;
  }
  const pointer = readSmallTextFile(gitPath, 4096)?.trim();
  const match = pointer?.match(/^gitdir:\s*(.+)$/i);
  if (!match?.[1]) return undefined;
  const gitDir = path.isAbsolute(match[1])
    ? match[1]
    : path.resolve(worktreePath, match[1]);
  return fs.existsSync(gitDir) ? gitDir : undefined;
}

function resolveGitLocation(cwd: string): GitLocation | undefined {
  let current = path.resolve(cwd);
  while (true) {
    const gitDir = resolveGitDirAt(current);
    if (gitDir) return { gitDir, worktreePath: current };
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resolveGitCommonDir(gitDir: string): string {
  const commonDir = readSmallTextFile(path.join(gitDir, "commondir"), 4096)?.trim();
  if (!commonDir) return gitDir;
  const resolved = path.isAbsolute(commonDir)
    ? commonDir
    : path.resolve(gitDir, commonDir);
  return fs.existsSync(resolved) ? resolved : gitDir;
}

function readOriginRemoteUrl(configText: string | undefined): string | undefined {
  if (!configText) return undefined;
  let inOrigin = false;
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = line.match(/^url\s*=\s*(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function readGitRemote(cwd: string): string | undefined {
  const location = resolveGitLocation(cwd);
  if (!location) return undefined;
  const commonDir = resolveGitCommonDir(location.gitDir);
  return readOriginRemoteUrl(readSmallTextFile(path.join(location.gitDir, "config")))
    ?? readOriginRemoteUrl(readSmallTextFile(path.join(commonDir, "config")));
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function remoteFingerprint(remote: string): string {
  return crypto.createHash("sha256").update(remote).digest("hex");
}

function readGitHead(cwd: string): Pick<GitEvidence, "branch" | "commit"> {
  const location = resolveGitLocation(cwd);
  if (!location) return {};
  const commonDir = resolveGitCommonDir(location.gitDir);
  const head = readSmallTextFile(path.join(location.gitDir, "HEAD"), 4096)?.trim();
  if (!head) return {};
  const refPrefix = "ref: ";
  if (head.startsWith(refPrefix)) {
    const ref = head.slice(refPrefix.length).trim();
    if (!ref.startsWith("refs/heads/") || ref.includes("..")) return {};
    const refFile = path.join(location.gitDir, ...ref.split("/"));
    const commonRefFile = path.join(commonDir, ...ref.split("/"));
    const looseCommit = readSmallTextFile(refFile, 4096)?.trim()
      ?? readSmallTextFile(commonRefFile, 4096)?.trim();
    const packedRefs = readSmallTextFile(path.join(location.gitDir, "packed-refs"))
      ?? readSmallTextFile(path.join(commonDir, "packed-refs"));
    const packedCommit = packedRefs
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.endsWith(` ${ref}`))
      ?.split(/\s+/)[0];
    const commit = looseCommit ?? packedCommit;
    return {
      branch: ref.replace(/^refs\/heads\//, ""),
      commit: commit && /^[0-9a-f]{7,40}$/i.test(commit) ? commit : undefined,
    };
  }
  return /^[0-9a-f]{7,40}$/i.test(head) ? { commit: head } : {};
}

export function readGitEvidence(cwd: string): GitEvidence | undefined {
  const location = resolveGitLocation(cwd);
  if (!location) return undefined;
  const remote = readGitRemote(cwd);
  const head = readGitHead(cwd);
  const evidence: GitEvidence = {
    remoteUrlFingerprint: remote ? remoteFingerprint(remote) : undefined,
    branch: head.branch,
    worktreePath: location.worktreePath,
    commit: head.commit,
  };
  for (const key of Object.keys(evidence) as Array<keyof GitEvidence>) {
    if (!evidence[key]) delete evidence[key];
  }
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

function compactProjectRegistryInput(
  input: ProjectRegistryInput,
): ProjectRegistryInput {
  for (const key of Object.keys(input) as Array<keyof ProjectRegistryInput>) {
    if (input[key] === undefined) delete input[key];
  }
  return input;
}

function comparableProjectPath(value: string): string {
  let normalized = value.trim().replaceAll(String.fromCharCode(92), "/");
  const wsl = normalized.match(/^\/mnt\/([a-zA-Z])\/(.+)$/i);
  if (wsl) normalized = `${wsl[1]}:/${wsl[2]}`;
  const msys = normalized.match(/^\/?([a-zA-Z])\/(.+)$/);
  if (msys) normalized = `${msys[1]}:/${msys[2]}`;
  normalized = path.posix.normalize(normalized.replace(/\/+/g, "/"));
  if (normalized.length > 1 && normalized.endsWith("/"))
    normalized = normalized.slice(0, -1);
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function equivalentProjectPath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return comparableProjectPath(a) === comparableProjectPath(b);
}

function isAbsoluteProjectPath(value: string): boolean {
  const trimmed = value.trim();
  return path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed);
}

function inputPathValues(input: ProjectRegistryInput): string[] {
  return uniqueStrings([
    input.artifactRoot,
    input.runtimeStatePath,
    ...(input.knownRoots ?? []),
    ...(input.pathAliases ?? []),
  ]);
}

function registryConflictFailure(
  message: string,
): RegistryOperationResult<BmadProjectRegistry> {
  return {
    ok: false,
    error: {
      code: "REGISTRY_INVALID_SHAPE",
      message,
      writeOccurred: false,
      recoveryAction: {
        action: "resolve-project-id-conflict-before-retry",
        reason:
          "A registry record matched this project's paths but used a different Stable Internal Project ID.",
        timestamp: nowIso(),
      },
    },
  };
}

function renameIdentityWriteFailure(
  projectId: string,
  file: string,
  cause: unknown,
): ProjectRenameResult {
  return {
    ok: false,
    error: {
      code: "REGISTRY_WRITE_FAILED",
      message: `Registry rename completed for project '${projectId}', but local project identity could not be updated: ${file}`,
      writeOccurred: true,
      recoveryAction: {
        action: "repair-project-identity-display-name-and-retry",
        reason:
          "The registry display name may be newer than .bmad-runtime/project-identity.json; repair the local identity before running registration again.",
        timestamp: nowIso(),
      },
      cause: cause instanceof Error ? cause.message : String(cause),
    },
  };
}

function physicalFolderNameIssue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Physical folder name must not be empty.";
  if (/[\u0000-\u001f\u007f]/.test(trimmed))
    return "Physical folder name must not contain control characters.";
  if (trimmed === "." || trimmed === ".." || trimmed.includes(".."))
    return "Physical folder name must not contain dot-dot path traversal.";
  if (trimmed.includes("/") || trimmed.includes("\\"))
    return "Physical folder name must be a folder name, not a path.";
  if (/^[a-zA-Z]:/.test(trimmed))
    return "Physical folder name must not include a drive prefix.";
  return undefined;
}

function physicalFolderBlocked(
  input: {
    currentWorkspacePath: string;
    requestedFolderName: string;
    targetWorkspacePath?: string;
    projectId?: string;
    displayName?: string;
    checks: PhysicalFolderRenameCheck[];
  },
  recoveryAction: string,
  error: string,
  writeOccurred = false,
): PhysicalFolderRenamePreflightFailure {
  return {
    ok: false,
    writeOccurred,
    projectId: input.projectId,
    displayName: input.displayName,
    currentWorkspacePath: input.currentWorkspacePath,
    requestedFolderName: input.requestedFolderName,
    targetWorkspacePath: input.targetWorkspacePath,
    checks: input.checks,
    recoveryAction,
    error,
  };
}

function registryRecordForProject(
  registry: BmadProjectRegistry,
  projectId: string,
): ProjectRegistryRecord | undefined {
  return registry.projects.find((project) => project.projectId === projectId);
}

async function detectRegistryIdentityConflict(
  input: ProjectRegistryInput,
  options: RegistryOptions,
): Promise<RegistryOperationResult<BmadProjectRegistry> | undefined> {
  const existing = await loadRegistry(options);
  if (!existing.ok) {
    return existing.error.code === "REGISTRY_NOT_FOUND" ? undefined : existing;
  }
  const incomingPaths = new Set(inputPathValues(input).map(comparableProjectPath));
  for (const project of existing.value.projects) {
    if (project.projectId === input.projectId) continue;
    const matched = inputPathValues(project).some((projectPath) =>
      incomingPaths.has(comparableProjectPath(projectPath)),
    );
    if (matched) {
      return registryConflictFailure(
        `Registry project '${project.projectId}' matches local project paths but local identity is '${input.projectId}'.`,
      );
    }
  }
  return undefined;
}

function createIdentity(cwd: string, outputFolder: string, options: ProjectInitOptions = {}): ProjectIdentity {
  const createdAt = nowIso();
  const identity: ProjectIdentity = {
    version: 1,
    projectId: options.projectId ?? crypto.randomUUID(),
    projectName: options.projectName ?? path.basename(cwd),
    createdAt,
    rootFingerprint: {
      initialPath: cwd,
      bmadOutputRoot: toProjectRelative(cwd, outputFolder),
    },
    clonePolicy: "new-id-by-default",
  };
  const gitRemote = readGitRemote(cwd);
  if (gitRemote) identity.rootFingerprint.gitRemoteFingerprint = remoteFingerprint(gitRemote);
  return identity;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalNullableStateString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return optionalNonEmptyString(value);
}

function normalizeExistingIdentity(
  cwd: string,
  outputFolder: string,
  raw: unknown,
): ProjectIdentity | undefined {
  const record = asRecord(raw);
  const projectId = optionalNonEmptyString(record?.projectId);
  if (!projectId) return undefined;
  const rootFingerprint = asRecord(record?.rootFingerprint);
  const rawRemote = optionalNonEmptyString(rootFingerprint?.gitRemote);
  const gitRemoteFingerprint =
    optionalNonEmptyString(rootFingerprint?.gitRemoteFingerprint) ??
    (rawRemote ? remoteFingerprint(rawRemote) : undefined);
  const normalized: ProjectIdentity = {
    version: 1,
    projectId,
    projectName: optionalNonEmptyString(record?.projectName) ?? path.basename(cwd),
    createdAt: optionalNonEmptyString(record?.createdAt) ?? nowIso(),
    rootFingerprint: {
      initialPath: optionalNonEmptyString(rootFingerprint?.initialPath) ?? cwd,
      bmadOutputRoot:
        optionalNonEmptyString(rootFingerprint?.bmadOutputRoot) ??
        toProjectRelative(cwd, outputFolder),
    },
    clonePolicy: "new-id-by-default",
  };
  if (gitRemoteFingerprint)
    normalized.rootFingerprint.gitRemoteFingerprint = gitRemoteFingerprint;
  return normalized;
}

function createBaseline(cwd: string, identity: ProjectIdentity): BaselineLock {
  const cfg = loadPathConfig(cwd);
  const createdAt = nowIso();
  return {
    version: 1,
    projectId: identity.projectId,
    createdAt,
    updatedAt: createdAt,
    runtimeStateVersion: 1,
    bmadCatalogPath: "_bmad/_config/bmad-help.csv",
    outputFolder: toProjectRelative(cwd, cfg.output_folder),
    planningArtifacts: toProjectRelative(cwd, cfg.planning_artifacts),
    implementationArtifacts: toProjectRelative(cwd, cfg.implementation_artifacts),
    policy: "guided-reconcile-required-for-baseline-changes",
  };
}

export function getProjectIdentityFile(cwd: string): string {
  return path.join(getStateDir(cwd), PROJECT_IDENTITY_FILE);
}

export function getBaselineLockFile(cwd: string): string {
  return path.join(getStateDir(cwd), BASELINE_LOCK_FILE);
}

export function ensureProjectInitialized(cwd: string, options: ProjectInitOptions = {}): ProjectInitResult {
  const result: ProjectInitResult = { created: [], reused: [], skipped: [], identity: undefined as never, baseline: undefined as never };
  const cfg = loadPathConfig(cwd);

  ensureDir(getStateDir(cwd), result, cwd);
  ensureDir(cfg.output_folder, result, cwd);
  ensureDir(cfg.planning_artifacts, result, cwd);
  ensureDir(cfg.implementation_artifacts, result, cwd);
  ensureDir(cfg.project_knowledge, result, cwd);

  const stateFile = getStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    result.reused.push(toProjectRelative(cwd, stateFile));
  } else {
    writeJson(stateFile, createDefaultState());
    result.created.push(toProjectRelative(cwd, stateFile));
  }

  const identityFile = getProjectIdentityFile(cwd);
  const existingIdentity = normalizeExistingIdentity(
    cwd,
    cfg.output_folder,
    readJson<unknown>(identityFile),
  );
  if (existingIdentity) {
    result.identity = existingIdentity;
    writeJson(identityFile, existingIdentity);
    result.reused.push(toProjectRelative(cwd, identityFile));
  } else {
    const identity = createIdentity(cwd, cfg.output_folder, options);
    writeJson(identityFile, identity);
    result.identity = identity;
    result.created.push(toProjectRelative(cwd, identityFile));
  }

  const baselineFile = getBaselineLockFile(cwd);
  const existingBaseline = readJson<BaselineLock>(baselineFile);
  if (existingBaseline?.projectId === result.identity.projectId) {
    result.baseline = existingBaseline;
    result.reused.push(toProjectRelative(cwd, baselineFile));
  } else {
    const baseline = createBaseline(cwd, result.identity);
    writeJson(baselineFile, baseline);
    result.baseline = baseline;
    result.created.push(toProjectRelative(cwd, baselineFile));
  }

  return result;
}

export function buildProjectRegistryInput(
  cwd: string,
  result: ProjectInitResult,
): ProjectRegistryInput {
  const root = path.resolve(cwd);
  const cfg = loadPathConfig(root);
  const state = readJson<Record<string, unknown>>(getStateFile(root));
  const knownRoots = uniqueStrings([root, result.identity.rootFingerprint.initialPath]);
  return compactProjectRegistryInput({
    projectId: result.identity.projectId,
    displayName: result.identity.projectName,
    historicalAliases: [],
    knownRoots,
    artifactRoot: cfg.output_folder,
    runtimeStatePath: getStateFile(root),
    pathAliases: knownRoots,
    phase: typeof state?.phase === "string" ? state.phase : undefined,
    status: typeof state?.active === "boolean" ? (state.active ? "active" : "inactive") : undefined,
    currentWorkflow: optionalNullableStateString(state?.currentWorkflow),
    currentStory: optionalNullableStateString(state?.currentStory),
    lastSeenAt: nowIso(),
    gitEvidence: readGitEvidence(root),
  });
}

export async function ensureProjectRegistered(
  cwd: string,
  options: RegistryOptions = {},
): Promise<ProjectRegistrationResult> {
  const root = path.resolve(cwd);
  const result = ensureProjectInitialized(root);
  const input = buildProjectRegistryInput(root, result);
  const conflict = await detectRegistryIdentityConflict(input, options);
  const registry = conflict ?? (await upsertProjectRecord(input, options));
  return { ...result, registry };
}

export async function renameRegisteredProject(
  cwd: string,
  displayName: string,
  options: RegistryOptions = {},
): Promise<RegisteredProjectRenameResult> {
  const root = path.resolve(cwd);
  const initialized = ensureProjectInitialized(root);
  const availability = await checkProjectDisplayNameAvailable(
    { projectId: initialized.identity.projectId, displayName },
    options,
  );
  const initialRegistry = await loadRegistry(options);
  let initialization: ProjectRegistrationResult = {
    ...initialized,
    registry: initialRegistry.ok ? initialRegistry : availability.ok ? initialRegistry : availability,
  };
  if (!availability.ok) {
    return {
      initialization,
      registry: { ok: false, error: availability.error },
    };
  }

  let registry = await renameProjectDisplayName(
    { projectId: initialization.identity.projectId, displayName },
    options,
  );
  if (
    !registry.ok &&
    ["REGISTRY_NOT_FOUND", "REGISTRY_PROJECT_NOT_FOUND"].includes(
      registry.error.code,
    )
  ) {
    initialization = await ensureProjectRegistered(root, options);
    if (!initialization.registry.ok) {
      return {
        initialization,
        registry: { ok: false, error: initialization.registry.error },
      };
    }
    registry = await renameProjectDisplayName(
      { projectId: initialization.identity.projectId, displayName },
      options,
    );
  }
  if (!registry.ok) return { initialization, registry };

  const identity: ProjectIdentity = {
    ...initialization.identity,
    projectName: registry.value.rename.displayName,
  };
  try {
    writeJson(getProjectIdentityFile(root), identity);
  } catch (error) {
    return {
      initialization,
      registry: renameIdentityWriteFailure(
        initialization.identity.projectId,
        getProjectIdentityFile(root),
        error,
      ),
    };
  }
  return { initialization, registry, identity };
}

export async function preflightPhysicalFolderRename(
  cwd: string,
  requestedFolderName: string,
  options: PhysicalFolderRenameOptions = {},
): Promise<PhysicalFolderRenamePreflightResult> {
  const root = path.resolve(cwd);
  const cfg = loadPathConfig(root);
  const checks: PhysicalFolderRenameCheck[] = [];
  const folderName = requestedFolderName.trim();
  const targetPath = folderName ? path.resolve(path.dirname(root), folderName) : undefined;
  const identity = normalizeExistingIdentity(
    root,
    cfg.output_folder,
    readJson<unknown>(getProjectIdentityFile(root)),
  );

  const addCheck = (check: PhysicalFolderRenameCheck): void => {
    checks.push(check);
  };
  const block = (
    recoveryAction: string,
    error: string,
    writeOccurred = false,
  ): PhysicalFolderRenamePreflightFailure =>
    physicalFolderBlocked(
      {
        currentWorkspacePath: root,
        requestedFolderName: folderName,
        targetWorkspacePath: targetPath,
        projectId: identity?.projectId,
        displayName: identity?.projectName,
        checks,
      },
      recoveryAction,
      error,
      writeOccurred,
    );

  const folderIssue = physicalFolderNameIssue(folderName);
  addCheck({
    label: "folder-name",
    ok: !folderIssue,
    detail: folderIssue ?? "Requested physical folder name is a single safe folder segment.",
    path: folderName,
  });
  if (folderIssue) return block("provide-single-safe-folder-name", folderIssue);

  const parent = path.dirname(root);
  const targetParent = targetPath ? path.dirname(targetPath) : undefined;
  const targetIsSibling = equivalentProjectPath(parent, targetParent);
  addCheck({
    label: "target-boundary",
    ok: targetIsSibling,
    detail: targetIsSibling
      ? "Target folder stays beside the current workspace root."
      : "Target folder would escape the current workspace parent.",
    path: targetPath,
  });
  if (!targetIsSibling)
    return block(
      "choose-folder-name-within-current-workspace-parent",
      "Physical folder rename target must stay beside the current workspace root.",
    );

  const targetDiffers = !equivalentProjectPath(root, targetPath);
  addCheck({
    label: "target-differs",
    ok: targetDiffers,
    detail: targetDiffers
      ? "Target folder differs from the current workspace path."
      : "Target folder is the current workspace path.",
    path: targetPath,
  });
  if (!targetDiffers)
    return block(
      "choose-different-folder-name",
      "Physical folder rename target is identical to the current workspace path.",
    );

  const targetAvailable = !targetPath || !fs.existsSync(targetPath);
  addCheck({
    label: "target-available",
    ok: targetAvailable,
    detail: targetAvailable
      ? "Target folder does not already exist."
      : "Target folder already exists.",
    path: targetPath,
  });
  if (!targetAvailable)
    return block(
      "choose-empty-or-nonexistent-target-folder",
      "Physical folder rename target already exists; runtime will not merge workspaces.",
    );

  addCheck({
    label: "explicit-confirmation",
    ok: options.explicitConfirmation === true,
    detail: options.explicitConfirmation === true
      ? "User explicitly confirmed physical folder rename preflight."
      : "Explicit confirmation is required before physical folder rename preflight can pass.",
  });
  if (options.explicitConfirmation !== true)
    return block(
      "rerun-with---confirm-folder-rename",
      "Physical folder rename requires explicit confirmation. Display-name rename never implies a folder move.",
    );

  addCheck({
    label: "local-identity",
    ok: !!identity,
    detail: identity
      ? `Local identity found for project '${identity.projectId}'.`
      : "Local project identity is missing or invalid.",
    path: getProjectIdentityFile(root),
  });
  if (!identity)
    return block(
      "run-bmad-start-or-init-before-folder-rename",
      "Physical folder rename preflight requires an existing local project identity.",
    );

  const baseline = readJson<BaselineLock>(getBaselineLockFile(root));
  const baselineMatches = baseline?.projectId === identity.projectId;
  addCheck({
    label: "baseline-project-id",
    ok: baselineMatches,
    detail: baselineMatches
      ? "Baseline lock belongs to the same Stable Internal Project ID."
      : "Baseline lock is missing or belongs to a different project.",
    path: getBaselineLockFile(root),
  });
  if (!baselineMatches)
    return block(
      "repair-baseline-lock-before-folder-rename",
      "Physical folder rename preflight requires a baseline lock for the same Stable Internal Project ID.",
    );

  const identityOutput = path.resolve(root, identity.rootFingerprint.bmadOutputRoot);
  const identityOutputMatches = equivalentProjectPath(identityOutput, cfg.output_folder);
  addCheck({
    label: "identity-output-root",
    ok: identityOutputMatches,
    detail: identityOutputMatches
      ? "Project identity output root matches runtime path config."
      : "Project identity output root differs from runtime path config.",
    path: identityOutput,
  });
  if (!identityOutputMatches)
    return block(
      "repair-project-identity-output-root-before-folder-rename",
      "Project identity output root does not match runtime path config; display name must not be treated as a path.",
    );

  const baselineOutput = path.resolve(root, baseline.outputFolder);
  const baselineOutputMatches = equivalentProjectPath(baselineOutput, cfg.output_folder);
  addCheck({
    label: "baseline-output-root",
    ok: baselineOutputMatches,
    detail: baselineOutputMatches
      ? "Baseline output folder matches runtime path config."
      : "Baseline output folder differs from runtime path config.",
    path: baselineOutput,
  });
  if (!baselineOutputMatches)
    return block(
      "repair-baseline-output-root-before-folder-rename",
      "Baseline output folder does not match runtime path config; physical rename is blocked before mutation.",
    );

  const artifactRootExists = fs.existsSync(cfg.output_folder);
  addCheck({
    label: "artifact-root-exists",
    ok: artifactRootExists,
    detail: artifactRootExists
      ? "Runtime artifact root exists."
      : "Runtime artifact root is missing.",
    path: cfg.output_folder,
  });
  if (!artifactRootExists)
    return block(
      "restore-artifact-root-before-folder-rename",
      "Runtime artifact root is missing; physical rename is blocked before mutation.",
    );

  const stateFileExists = fs.existsSync(getStateFile(root));
  addCheck({
    label: "runtime-state-exists",
    ok: stateFileExists,
    detail: stateFileExists
      ? "Runtime state file exists."
      : "Runtime state file is missing.",
    path: getStateFile(root),
  });
  if (!stateFileExists)
    return block(
      "restore-runtime-state-before-folder-rename",
      "Runtime state file is missing; physical rename is blocked before mutation.",
    );

  const registry = await loadRegistry(options);
  addCheck({
    label: "registry-load",
    ok: registry.ok,
    detail: registry.ok
      ? "Project registry loaded."
      : registry.error.message,
  });
  if (!registry.ok)
    return block(
      registry.error.recoveryAction.action,
      registry.error.message,
      registry.error.writeOccurred,
    );

  const project = registryRecordForProject(registry.value, identity.projectId);
  addCheck({
    label: "registry-project",
    ok: !!project,
    detail: project
      ? "Registry contains the local Stable Internal Project ID."
      : "Registry does not contain the local Stable Internal Project ID.",
  });
  if (!project)
    return block(
      "register-project-before-folder-rename",
      "Physical folder rename preflight requires the current project to exist in the registry.",
    );

  const knownRootMatches = [
    ...project.knownRoots,
    ...project.pathAliases.filter(isAbsoluteProjectPath),
  ].some((candidate) => equivalentProjectPath(candidate, root));
  addCheck({
    label: "registry-known-root",
    ok: knownRootMatches,
    detail: knownRootMatches
      ? "Registry points at the current workspace root."
      : "Registry does not point at the current workspace root.",
    path: root,
  });
  if (!knownRootMatches)
    return block(
      "rebind-current-workspace-before-folder-rename",
      "Registry root binding does not match this workspace; physical rename is blocked before mutation.",
    );

  const registryArtifactMatches = equivalentProjectPath(project.artifactRoot, cfg.output_folder);
  addCheck({
    label: "registry-artifact-root",
    ok: registryArtifactMatches,
    detail: registryArtifactMatches
      ? "Registry artifact root matches runtime path config."
      : "Registry artifact root differs from runtime path config.",
    path: project.artifactRoot,
  });
  if (!registryArtifactMatches)
    return block(
      "repair-registry-artifact-root-before-folder-rename",
      "Registry artifact root does not match runtime path config; physical rename is blocked before mutation.",
    );

  const registryStateMatches = equivalentProjectPath(project.runtimeStatePath, getStateFile(root));
  addCheck({
    label: "registry-runtime-state",
    ok: registryStateMatches,
    detail: registryStateMatches
      ? "Registry runtime state path matches the current workspace."
      : "Registry runtime state path differs from the current workspace.",
    path: project.runtimeStatePath,
  });
  if (!registryStateMatches)
    return block(
      "repair-registry-runtime-state-before-folder-rename",
      "Registry runtime state path does not match this workspace; physical rename is blocked before mutation.",
    );

  return {
    ok: true,
    writeOccurred: false,
    projectId: identity.projectId,
    displayName: project.displayName,
    currentWorkspacePath: root,
    requestedFolderName: folderName,
    targetWorkspacePath: targetPath!,
    artifactRoot: cfg.output_folder,
    runtimeStatePath: getStateFile(root),
    checks,
    nextSafeAction:
      "Close Pi, move the folder outside the active agent session, reopen Pi in the new folder, then run /bmad-start to confirm/rebind.",
  };
}

export function formatPhysicalFolderRenamePreflight(
  result: PhysicalFolderRenamePreflightResult,
): string {
  const checks = result.checks.map((check) =>
    `- ${check.ok ? "ok" : "blocked"} ${check.label}: ${check.detail}${check.path ? ` (${check.path})` : ""}`,
  );
  if (result.ok) {
    return [
      "BMAD physical folder rename preflight passed.",
      `Project ID: ${result.projectId}`,
      `Display name: ${result.displayName}`,
      `Current workspace: ${result.currentWorkspacePath}`,
      `Requested folder name: ${result.requestedFolderName}`,
      `Target workspace: ${result.targetWorkspacePath}`,
      "Display name mutation: not performed",
      "Physical folder rename: not performed by runtime",
      "Write occurred: false",
      `Next safe action: ${result.nextSafeAction}`,
      "",
      "Checks:",
      ...checks,
    ].join("\n");
  }
  return [
    "BMAD physical folder rename preflight blocked.",
    result.projectId ? `Project ID: ${result.projectId}` : "Project ID: unresolved",
    result.displayName ? `Display name: ${result.displayName}` : "Display name: unresolved",
    `Current workspace: ${result.currentWorkspacePath}`,
    `Requested folder name: ${result.requestedFolderName || "missing"}`,
    result.targetWorkspacePath ? `Target workspace: ${result.targetWorkspacePath}` : "Target workspace: unresolved",
    `Error: ${result.error}`,
    `Recovery: ${result.recoveryAction}`,
    `Write occurred: ${result.writeOccurred}`,
    "Display name was not treated as a filesystem path.",
    "",
    "Checks:",
    ...checks,
  ].join("\n");
}

export async function registerCurrentProjectPathAlias(
  cwd: string,
  pathAlias: string,
  options: ProjectPathAliasOptions = {},
): Promise<CurrentProjectPathAliasResult> {
  const root = path.resolve(cwd);
  const { knownRoot, ...registryOptions } = options;
  let registry = await addProjectPathAlias(
    {
      projectId:
        normalizeExistingIdentity(
          root,
          loadPathConfig(root).output_folder,
          readJson<unknown>(getProjectIdentityFile(root)),
        )?.projectId ?? "pending-local-project",
      pathAlias,
      knownRoot,
    },
    registryOptions,
  );
  let initialization: ProjectRegistrationResult | undefined;
  if (
    !registry.ok &&
    ["REGISTRY_NOT_FOUND", "REGISTRY_PROJECT_NOT_FOUND"].includes(
      registry.error.code,
    )
  ) {
    initialization = await ensureProjectRegistered(root, registryOptions);
    if (!initialization.registry.ok) {
      return {
        initialization,
        registry: { ok: false, error: initialization.registry.error },
      };
    }
    registry = await addProjectPathAlias(
      {
        projectId: initialization.identity.projectId,
        pathAlias,
        knownRoot,
      },
      registryOptions,
    );
  }
  return { initialization, registry };
}

function linesFor(label: string, paths: string[]): string[] {
  return paths.length === 0 ? [`${label}: none`] : [`${label}:`, ...paths.map((item) => `- ${item}`)];
}

export function formatProjectInitResult(result: ProjectInitResult): string {
  return [
    "BMAD project initialization complete.",
    `Project ID: ${result.identity.projectId}`,
    `Project name: ${result.identity.projectName}`,
    "",
    ...linesFor("Created", result.created),
    "",
    ...linesFor("Reused", result.reused),
    "",
    ...linesFor("Skipped", result.skipped),
  ].join("\n");
}

export function formatProjectRegistrationResult(
  result: ProjectRegistrationResult,
): string {
  const registryLines = result.registry.ok
    ? [
        "Registry:",
        `- updated: ${result.registry.writeOccurred ? "yes" : "already current"}`,
        `- projects: ${result.registry.value.projects.length}`,
      ]
    : [
        "Registry:",
        `- error: ${result.registry.error.code}`,
        `- message: ${result.registry.error.message}`,
        `- recovery: ${result.registry.error.recoveryAction.action}`,
      ];
  return [formatProjectInitResult(result), "", ...registryLines].join("\n");
}
