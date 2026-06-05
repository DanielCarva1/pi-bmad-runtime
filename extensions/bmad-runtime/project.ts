import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadPathConfig, toProjectRelative } from "./paths.js";
import { createDefaultState, getStateDir, getStateFile } from "./state.js";

export interface ProjectIdentity {
  version: 1;
  projectId: string;
  projectName: string;
  createdAt: string;
  rootFingerprint: {
    initialPath: string;
    gitRemote?: string;
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

export interface ProjectInitResult {
  created: string[];
  reused: string[];
  skipped: string[];
  identity: ProjectIdentity;
  baseline: BaselineLock;
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

function readGitRemote(cwd: string): string | undefined {
  const config = path.join(cwd, ".git", "config");
  if (!fs.existsSync(config)) return undefined;
  const text = fs.readFileSync(config, "utf8");
  const origin = text.match(/\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*([^\n]+)/);
  return origin?.[1]?.trim();
}

function createIdentity(cwd: string, outputFolder: string): ProjectIdentity {
  const createdAt = nowIso();
  const identity: ProjectIdentity = {
    version: 1,
    projectId: crypto.randomUUID(),
    projectName: path.basename(cwd),
    createdAt,
    rootFingerprint: {
      initialPath: cwd,
      bmadOutputRoot: toProjectRelative(cwd, outputFolder),
    },
    clonePolicy: "new-id-by-default",
  };
  const gitRemote = readGitRemote(cwd);
  if (gitRemote) identity.rootFingerprint.gitRemote = gitRemote;
  return identity;
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

export function ensureProjectInitialized(cwd: string): ProjectInitResult {
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
  const existingIdentity = readJson<ProjectIdentity>(identityFile);
  if (existingIdentity?.projectId) {
    result.identity = existingIdentity;
    result.reused.push(toProjectRelative(cwd, identityFile));
  } else {
    const identity = createIdentity(cwd, cfg.output_folder);
    writeJson(identityFile, identity);
    result.identity = identity;
    result.created.push(toProjectRelative(cwd, identityFile));
  }

  const baselineFile = getBaselineLockFile(cwd);
  const existingBaseline = readJson<BaselineLock>(baselineFile);
  if (existingBaseline?.projectId) {
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
