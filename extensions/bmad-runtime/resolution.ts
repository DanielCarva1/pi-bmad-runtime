import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeRuntimeBoundaries, formatRuntimeBoundaries, type RuntimeBoundary, type RuntimeBoundaryOptions } from "./boundaries.js";
import { loadPathConfig, toProjectRelative } from "./paths.js";
import { getBaselineLockFile, getProjectIdentityFile, readGitEvidence, type ProjectIdentity } from "./project.js";
import { loadRegistry, resolveRegistryPath, upsertProjectRecord, type GitEvidence, type ProjectRegistryInput, type ProjectRegistryRecord, type RegistryOptions } from "./registry.js";
import { getStateFile, loadState, type RuntimeState } from "./state.js";

export type ResolutionConfidence =
  | "unique_confident"
  | "ambiguous"
  | "blocked"
  | "new_project_intent_required"
  | "local_workspace_unregistered"
  | "needs_rebind"
  | "variant_choice_required";

export interface ResolutionEvidence {
  kind:
    | "cwd"
    | "registry"
    | "state"
    | "identity"
    | "artifacts"
    | "git"
    | "boundary"
    | "candidate-match"
    | "reconcile"
    | "suspicious";
  label: string;
  value: string;
  path?: string;
  projectId?: string;
}

export interface ResolutionCandidate {
  projectId: string;
  displayName: string;
  historicalAliases: string[];
  score: number;
  matchedBy: ResolutionEvidence[];
  phase?: string;
  status?: string;
  currentWorkflow?: string | null;
  currentStory?: string | null;
  lastSeenAt?: string;
  gitEvidence?: GitEvidence;
  canonicalPaths: {
    knownRoots: string[];
    artifactRoot: string;
    runtimeStatePath: string;
    pathAliases: string[];
  };
}

export interface ProjectPickerOption {
  index: number;
  projectId: string;
  displayName: string;
  score: number;
  lastSeenAt?: string;
  status?: string;
  matchSummary: string;
}

export interface GenericGitRepositoryIntent {
  worktreePath: string;
  branch?: string;
  commit?: string;
  remoteUrlFingerprint?: string;
}

export type ResolutionAction =
  | "activate_resolved_project"
  | "show_project_picker"
  | "reconcile_existing_workspace"
  | "confirm_workspace_rebind"
  | "choose_project_variant"
  | "block_resolution"
  | "require_explicit_project_intent"
  | "repair_before_retry";

export interface ResolutionExplanation {
  action: ResolutionAction;
  confidenceReason: string;
  evidenceUsed: string[];
  rejectedAlternatives: string[];
  writeOccurred: boolean;
  recoveryAction?: string;
  safeRecoveryStatus: "yes" | "no" | "not_required";
  nextSafeAction: string;
}

export interface ProjectResolutionResult {
  confidence: ResolutionConfidence;
  selectedProjectId?: string;
  selectedProject?: ResolutionCandidate;
  candidates: ResolutionCandidate[];
  evidenceUsed: ResolutionEvidence[];
  rejectedCandidates: ResolutionCandidate[];
  reason: string;
  nextSafeAction: string;
  writeAllowed: boolean;
  writeOccurred: false;
  recoveryAction?: string;
  canonicalPaths: {
    cwd: string;
    projectWorkspace: string;
    outputFolder: string;
    planningArtifacts: string;
    implementationArtifacts: string;
    projectKnowledge: string;
    runtimeStatePath: string;
    projectIdentityPath: string;
    registryPath?: string;
  };
  boundaries: RuntimeBoundary[];
  localWorkspace?: LocalWorkspaceCandidate;
  reconcileAllowed?: boolean;
  suspiciousCwd?: SuspiciousCwdFinding;
  genericGitRepo?: GenericGitRepositoryIntent;
}

export interface ProjectInitSafetyDecision {
  blocked: boolean;
  reason?: string;
  recoveryAction?: string;
}

export interface SuspiciousCwdFinding {
  reasons: string[];
  affectedPath: string;
  recoveryAction: string;
  evidence: ResolutionEvidence[];
}

export interface LocalWorkspaceCandidate {
  projectId: string;
  displayName: string;
  projectRoot: string;
  artifactRoot: string;
  runtimeStatePath: string;
  projectIdentityPath: string;
  baselineLockPath: string;
  compatibility: "v0.2" | "v0.1.1-compatible";
  evidence: ResolutionEvidence[];
}

export interface WorkspaceReconcileResult {
  ok: boolean;
  writeOccurred: boolean;
  projectId?: string;
  touchedPaths: string[];
  compatibilityEvidence: ResolutionEvidence[];
  registryProjectCount?: number;
  recoveryAction?: string;
  error?: string;
}

export interface WorkspaceRebindResult {
  ok: boolean;
  writeOccurred: boolean;
  projectId?: string;
  touchedPaths: string[];
  compatibilityEvidence: ResolutionEvidence[];
  previousKnownRoots?: string[];
  addedKnownRoot?: string;
  registryProjectCount?: number;
  recoveryAction?: string;
  error?: string;
}

export interface ProjectVariantChoiceResult {
  ok: boolean;
  writeOccurred: boolean;
  projectId?: string;
  touchedPaths: string[];
  compatibilityEvidence: ResolutionEvidence[];
  previousGitEvidence?: GitEvidence;
  selectedGitEvidence?: GitEvidence;
  registryProjectCount?: number;
  recoveryAction?: string;
  error?: string;
}

export interface ProjectResolutionOptions extends RegistryOptions, RuntimeBoundaryOptions {
  registryPath?: string;
}

interface JsonReadStatus<T> {
  exists: boolean;
  ok: boolean;
  value?: T;
  error?: string;
}

function readJsonStatus<T>(file: string): JsonReadStatus<T> {
  if (!fs.existsSync(file)) return { exists: false, ok: false };
  try {
    return { exists: true, ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) as T };
  } catch (error) {
    return { exists: true, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isProjectIdentity(value: unknown): value is ProjectIdentity {
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.projectId === "string" && value.projectId.trim().length > 0 &&
    typeof value.projectName === "string" && value.projectName.trim().length > 0 &&
    isRecord(value.rootFingerprint) &&
    typeof value.rootFingerprint.initialPath === "string" &&
    typeof value.rootFingerprint.bmadOutputRoot === "string";
}

function isRuntimeState(value: unknown): value is RuntimeState {
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.phase === "string" &&
    typeof value.mode === "string" &&
    typeof value.active === "boolean";
}

function comparablePath(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let normalized = raw.replaceAll(String.fromCharCode(92), "/");
  const wsl = normalized.match(/^\/mnt\/([a-zA-Z])\/(.+)$/i);
  if (wsl) normalized = `${wsl[1]}:/${wsl[2]}`;
  const msys = normalized.match(/^\/?([a-zA-Z])\/(.+)$/);
  if (msys) normalized = `${msys[1]}:/${msys[2]}`;
  normalized = path.posix.normalize(normalized.replace(/\/+/g, "/"));
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function pathsEquivalent(a: string | undefined, b: string | undefined): boolean {
  const left = comparablePath(a);
  const right = comparablePath(b);
  return !!left && !!right && left === right;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function directoryEntries(root: string): string[] {
  try {
    return fs.readdirSync(root).filter((entry) => entry !== ".DS_Store");
  } catch {
    return [];
  }
}

function isGenericFolderName(root: string): boolean {
  const name = path.basename(root).trim().toLowerCase();
  return ["", "home", "tmp", "temp", "workspace", "workspaces", "projects", "project", "repo", "repos", "test", "tests", "untitled", "new-folder"].includes(name);
}

function detectSuspiciousCwd(
  root: string,
  cfg: ReturnType<typeof loadPathConfig>,
  localWorkspace: LocalWorkspaceCandidate | undefined,
  candidates: ResolutionCandidate[],
  registryProjectCount: number | undefined,
  localGit?: GitEvidence,
): SuspiciousCwdFinding | undefined {
  if (localWorkspace) return undefined;
  const reasons: string[] = [];
  const evidenceItems: ResolutionEvidence[] = [];
  const home = path.resolve(os.homedir());
  const temp = path.resolve(os.tmpdir());
  const parsedRoot = path.parse(root).root;
  if (pathsEquivalent(root, home)) {
    reasons.push("cwd is the user home directory");
    evidenceItems.push(evidence("suspicious", "home directory cwd", root, { path: root }));
  }
  if (pathsEquivalent(root, parsedRoot)) {
    reasons.push("cwd is a filesystem root");
    evidenceItems.push(evidence("suspicious", "filesystem root cwd", root, { path: root }));
  }
  if (isPathInside(root, temp)) {
    reasons.push("cwd is inside the system temp directory");
    evidenceItems.push(evidence("suspicious", "temp directory cwd", root, { path: root }));
  }
  const entries = directoryEntries(root);
  if (entries.length === 0) {
    reasons.push("cwd is an empty folder");
    evidenceItems.push(evidence("suspicious", "empty folder", root, { path: root }));
  }
  if (isGenericFolderName(root) && !localGit) {
    reasons.push("cwd has a generic folder name");
    evidenceItems.push(evidence("suspicious", "generic folder name", path.basename(root) || root, { path: root }));
  }
  if (!fs.existsSync(getProjectIdentityFile(root)) && !fs.existsSync(cfg.output_folder) && !localGit) {
    reasons.push("cwd has no BMAD binding (.bmad-runtime identity or artifact root)");
    evidenceItems.push(evidence("suspicious", "missing BMAD binding", `${getProjectIdentityFile(root)} | ${cfg.output_folder}`, { path: root }));
  }
  if ((registryProjectCount ?? 0) > 0 && candidates.length === 0 && !localGit) {
    reasons.push("cwd is outside all known registry roots/candidates");
    evidenceItems.push(evidence("suspicious", "outside known registry roots", `${registryProjectCount} registry projects checked`, { path: root }));
  }
  if (reasons.length === 0) return undefined;
  return {
    reasons: uniqueStrings(reasons),
    affectedPath: root,
    recoveryAction: "navigate-to-known-project-or-use-explicit-init-or-dedicated-workspace-flow",
    evidence: evidenceItems,
  };
}

function hasLocalBmadBinding(root: string, cfg: ReturnType<typeof loadPathConfig>, localWorkspace: LocalWorkspaceCandidate | undefined): boolean {
  void cfg;
  return Boolean(localWorkspace) || fs.existsSync(getProjectIdentityFile(root));
}

function genericGitIntent(localGit: GitEvidence): GenericGitRepositoryIntent {
  return {
    worktreePath: localGit.worktreePath ?? "unknown",
    branch: localGit.branch,
    commit: localGit.commit,
    remoteUrlFingerprint: localGit.remoteUrlFingerprint,
  };
}

function isGenericGitRepositoryWithoutBmadBinding(root: string, cfg: ReturnType<typeof loadPathConfig>, localWorkspace: LocalWorkspaceCandidate | undefined, localGit: GitEvidence | undefined): localGit is GitEvidence {
  return Boolean(localGit) && !hasLocalBmadBinding(root, cfg, localWorkspace);
}

function genericGitIntentResult(base: {
  root: string;
  cfg: ReturnType<typeof loadPathConfig>;
  localGit: GitEvidence;
  candidates: ResolutionCandidate[];
  rejectedCandidates?: ResolutionCandidate[];
  evidenceUsed: ResolutionEvidence[];
  registryEvidence?: ResolutionEvidence;
  canonicalPaths: ProjectResolutionResult["canonicalPaths"];
  boundaries: RuntimeBoundary[];
  reason?: string;
  recoveryAction?: string;
}): ProjectResolutionResult {
  const genericGit = genericGitIntent(base.localGit);
  return result({
    confidence: "new_project_intent_required",
    candidates: base.candidates,
    evidenceUsed: [
      ...base.evidenceUsed,
      ...(base.registryEvidence ? [base.registryEvidence] : []),
      evidence("git", "generic git working tree requires explicit BMAD intent", JSON.stringify(genericGit), { path: genericGit.worktreePath }),
      evidence("identity", "local BMAD identity missing", getProjectIdentityFile(base.root), { path: getProjectIdentityFile(base.root) }),
      evidence("artifacts", "BMAD artifact root missing", base.cfg.output_folder, { path: base.cfg.output_folder }),
    ],
    rejectedCandidates: base.rejectedCandidates ?? base.candidates,
    reason: base.reason ?? "Generic git repository detected without local BMAD binding or registry binding; /bmad start must not create a Project Workspace implicitly.",
    nextSafeAction: "Run /bmad init --confirm-generic-repo only if this git repository is intentionally the BMAD Project Workspace.",
    writeAllowed: false,
    recoveryAction: base.recoveryAction ?? "confirm-generic-git-repo-before-init",
    canonicalPaths: base.canonicalPaths,
    boundaries: base.boundaries,
    genericGitRepo: genericGit,
  });
}

function suspiciousBlockedResult(
  suspicious: SuspiciousCwdFinding,
  base: {
    candidates: ResolutionCandidate[];
    evidenceUsed: ResolutionEvidence[];
    registryEvidence?: ResolutionEvidence;
    canonicalPaths: ProjectResolutionResult["canonicalPaths"];
    boundaries: RuntimeBoundary[];
  },
): ProjectResolutionResult {
  return result({
    confidence: "blocked",
    candidates: base.candidates,
    evidenceUsed: [
      ...base.evidenceUsed,
      ...(base.registryEvidence ? [base.registryEvidence] : []),
      ...suspicious.evidence,
    ],
    rejectedCandidates: base.candidates,
    reason: `Suspicious cwd blocked: ${suspicious.reasons.join("; ")}. Affected path: ${suspicious.affectedPath}.`,
    nextSafeAction: "Move to an intended BMAD Project Workspace and run /bmad-start to select/create a project; use /bmad init only after explicit repair intent.",
    writeAllowed: false,
    recoveryAction: suspicious.recoveryAction,
    canonicalPaths: base.canonicalPaths,
    boundaries: base.boundaries,
    suspiciousCwd: suspicious,
  });
}

function evidence(
  kind: ResolutionEvidence["kind"],
  label: string,
  value: string,
  options: { path?: string; projectId?: string } = {},
): ResolutionEvidence {
  return { kind, label, value, ...options };
}

function hasAnyArtifacts(cfg: ReturnType<typeof loadPathConfig>): boolean {
  return [
    cfg.output_folder,
    cfg.planning_artifacts,
    cfg.implementation_artifacts,
    cfg.project_knowledge,
  ].some((item) => fs.existsSync(item));
}

function compactInput(input: ProjectRegistryInput): ProjectRegistryInput {
  for (const key of Object.keys(input) as Array<keyof ProjectRegistryInput>) {
    if (input[key] === undefined) delete input[key];
  }
  return input;
}

function detectLocalWorkspace(
  root: string,
  cfg: ReturnType<typeof loadPathConfig>,
  identityStatus: JsonReadStatus<ProjectIdentity>,
  stateStatus: JsonReadStatus<RuntimeState>,
): LocalWorkspaceCandidate | undefined {
  const identity = identityStatus.value;
  if (!identityStatus.ok || !isProjectIdentity(identity)) return undefined;
  if (!fs.existsSync(cfg.output_folder)) return undefined;
  const baselinePath = getBaselineLockFile(root);
  const baseline = readJsonStatus<Record<string, unknown>>(baselinePath);
  if (baseline.exists && (!baseline.ok || baseline.value?.version !== 1)) return undefined;
  const compatibility = baseline.ok && baseline.value?.version === 1 ? "v0.2" : "v0.1.1-compatible";
  const evidenceItems = [
    evidence("identity", "existing project identity", identity.projectId, { path: getProjectIdentityFile(root), projectId: identity.projectId }),
    evidence("state", stateStatus.ok ? "existing runtime state" : "runtime state missing but identity/artifacts exist", stateStatus.ok ? stateStatus.value?.phase ?? "present" : "missing", { path: getStateFile(root), projectId: identity.projectId }),
    evidence("artifacts", "existing artifact root", cfg.output_folder, { path: cfg.output_folder, projectId: identity.projectId }),
    evidence("reconcile", baseline.ok ? "baseline lock compatible" : "baseline lock absent or legacy-compatible", compatibility, { path: baselinePath, projectId: identity.projectId }),
  ];
  return {
    projectId: identity.projectId,
    displayName: identity.projectName || path.basename(root),
    projectRoot: root,
    artifactRoot: cfg.output_folder,
    runtimeStatePath: getStateFile(root),
    projectIdentityPath: getProjectIdentityFile(root),
    baselineLockPath: baselinePath,
    compatibility,
    evidence: evidenceItems,
  };
}

function registryInputForLocalWorkspace(
  root: string,
  cfg: ReturnType<typeof loadPathConfig>,
  localWorkspace: LocalWorkspaceCandidate,
  state: RuntimeState,
): ProjectRegistryInput {
  const knownRoots = uniqueStrings([root]);
  return compactInput({
    projectId: localWorkspace.projectId,
    displayName: localWorkspace.displayName,
    historicalAliases: [],
    knownRoots,
    artifactRoot: cfg.output_folder,
    runtimeStatePath: getStateFile(root),
    pathAliases: knownRoots,
    phase: state.phase,
    status: state.active ? "active" : "inactive",
    currentWorkflow: state.currentWorkflow,
    currentStory: state.currentStory,
    lastSeenAt: new Date().toISOString(),
    gitEvidence: readGitEvidence(root),
  });
}

function artifactEvidence(cfg: ReturnType<typeof loadPathConfig>): ResolutionEvidence[] {
  const entries: Array<[string, string]> = [
    ["output_folder", cfg.output_folder],
    ["planning_artifacts", cfg.planning_artifacts],
    ["implementation_artifacts", cfg.implementation_artifacts],
    ["project_knowledge", cfg.project_knowledge],
  ];
  return entries
    .filter(([, file]) => fs.existsSync(file))
    .map(([label, file]) => evidence("artifacts", label, file, { path: file }));
}

function pathMatches(project: ProjectRegistryRecord, cwd: string, cfg: ReturnType<typeof loadPathConfig>): ResolutionEvidence[] {
  const out: ResolutionEvidence[] = [];
  for (const root of project.knownRoots ?? []) {
    if (pathsEquivalent(root, cwd)) out.push(evidence("candidate-match", "knownRoot matches cwd", root, { path: root, projectId: project.projectId }));
  }
  for (const alias of project.pathAliases ?? []) {
    if (path.isAbsolute(alias) && pathsEquivalent(alias, cwd)) out.push(evidence("candidate-match", "pathAlias matches cwd", alias, { path: alias, projectId: project.projectId }));
  }
  if (pathsEquivalent(project.artifactRoot, cfg.output_folder)) {
    if (fs.existsSync(cfg.output_folder)) {
      out.push(evidence("candidate-match", "artifactRoot matches output_folder", project.artifactRoot, { path: project.artifactRoot, projectId: project.projectId }));
    }
  }
  if (pathsEquivalent(project.runtimeStatePath, getStateFile(cwd))) {
    if (fs.existsSync(getStateFile(cwd))) {
      out.push(evidence("candidate-match", "runtimeStatePath matches local state", project.runtimeStatePath, { path: project.runtimeStatePath, projectId: project.projectId }));
    }
  }
  return out;
}

function gitMatches(project: ProjectRegistryRecord, git: GitEvidence | undefined): ResolutionEvidence[] {
  if (!project.gitEvidence || !git) return [];
  if (project.gitEvidence.branch && project.gitEvidence.branch !== git.branch) return [];
  if (project.gitEvidence.commit && project.gitEvidence.commit !== git.commit) return [];
  const out: ResolutionEvidence[] = [];
  if (
    project.gitEvidence.remoteUrlFingerprint &&
    git.remoteUrlFingerprint &&
    project.gitEvidence.remoteUrlFingerprint === git.remoteUrlFingerprint
  ) {
    out.push(evidence("candidate-match", "git remote fingerprint matches", git.remoteUrlFingerprint, { projectId: project.projectId }));
  }
  if (project.gitEvidence.worktreePath && git.worktreePath && pathsEquivalent(project.gitEvidence.worktreePath, git.worktreePath)) {
    out.push(evidence("candidate-match", "git worktree path matches", git.worktreePath, { path: git.worktreePath, projectId: project.projectId }));
  }
  return out;
}

function gitConflict(project: ProjectRegistryRecord, git: GitEvidence | undefined): ResolutionEvidence | undefined {
  if (!project.gitEvidence || !git) return undefined;
  const conflicts: string[] = [];
  if (project.gitEvidence.remoteUrlFingerprint && git.remoteUrlFingerprint && project.gitEvidence.remoteUrlFingerprint !== git.remoteUrlFingerprint) conflicts.push("remote fingerprint differs");
  if (project.gitEvidence.branch && git.branch && project.gitEvidence.branch !== git.branch) conflicts.push("branch differs");
  if (project.gitEvidence.commit && git.commit && project.gitEvidence.commit !== git.commit) conflicts.push("commit differs");
  if (project.gitEvidence.worktreePath && git.worktreePath && !pathsEquivalent(project.gitEvidence.worktreePath, git.worktreePath)) conflicts.push("worktree path differs");
  if (conflicts.length === 0) return undefined;
  return evidence("git", "registry/git evidence conflict", conflicts.join("; "), { path: git.worktreePath, projectId: project.projectId });
}

function identityMatches(project: ProjectRegistryRecord, identityValue: ProjectIdentity | undefined): ResolutionEvidence[] {
  if (!identityValue?.projectId || identityValue.projectId !== project.projectId) return [];
  return [evidence("candidate-match", "local project identity matches registry projectId", identityValue.projectId, { projectId: project.projectId })];
}

function candidateFor(
  project: ProjectRegistryRecord,
  cwd: string,
  cfg: ReturnType<typeof loadPathConfig>,
  identityValue: ProjectIdentity | undefined,
  git: GitEvidence | undefined,
): ResolutionCandidate | undefined {
  const matchedBy = [
    ...identityMatches(project, identityValue),
    ...pathMatches(project, cwd, cfg),
    ...gitMatches(project, git),
  ];
  if (matchedBy.length === 0) return undefined;
  const score = matchedBy.reduce((sum, item) => {
    if (item.label.includes("identity")) return sum + 5;
    if (item.label.includes("knownRoot") || item.label.includes("pathAlias")) return sum + 4;
    if (item.label.includes("artifactRoot") || item.label.includes("runtimeStatePath")) return sum + 3;
    if (item.label.includes("git remote")) return sum + 3;
    if (item.label.includes("git worktree")) return sum + 2;
    return sum + 1;
  }, 0);
  return {
    projectId: project.projectId,
    displayName: project.displayName,
    historicalAliases: project.historicalAliases ?? [],
    score,
    matchedBy,
    phase: project.phase,
    status: project.status,
    currentWorkflow: project.currentWorkflow,
    currentStory: project.currentStory,
    lastSeenAt: project.lastSeenAt,
    gitEvidence: project.gitEvidence,
    canonicalPaths: {
      knownRoots: project.knownRoots ?? [],
      artifactRoot: project.artifactRoot,
      runtimeStatePath: project.runtimeStatePath,
      pathAliases: project.pathAliases ?? [],
    },
  };
}

function hasWorkspaceMatch(candidate: ResolutionCandidate): boolean {
  return candidate.matchedBy.some((item) =>
    item.label.includes("knownRoot") ||
    item.label.includes("pathAlias") ||
    item.label.includes("artifactRoot") ||
    item.label.includes("runtimeStatePath"),
  );
}

function hasIdentityMatch(candidate: ResolutionCandidate): boolean {
  return candidate.matchedBy.some((item) => item.label.includes("identity"));
}

function isUniqueActivationCandidate(candidate: ResolutionCandidate): boolean {
  return hasWorkspaceMatch(candidate) && (hasIdentityMatch(candidate) || candidate.score >= 4);
}

function isNeedsRebindCandidate(candidate: ResolutionCandidate, localWorkspace: LocalWorkspaceCandidate | undefined): boolean {
  return !!localWorkspace &&
    candidate.projectId === localWorkspace.projectId &&
    hasIdentityMatch(candidate) &&
    !hasWorkspaceMatch(candidate);
}

function canonicalPaths(cwd: string, options: ProjectResolutionOptions): ProjectResolutionResult["canonicalPaths"] {
  const cfg = loadPathConfig(cwd);
  const registryPath = resolveRegistryPath(options);
  return {
    cwd,
    projectWorkspace: cwd,
    outputFolder: cfg.output_folder,
    planningArtifacts: cfg.planning_artifacts,
    implementationArtifacts: cfg.implementation_artifacts,
    projectKnowledge: cfg.project_knowledge,
    runtimeStatePath: getStateFile(cwd),
    projectIdentityPath: getProjectIdentityFile(cwd),
    registryPath,
  };
}

function result(input: Omit<ProjectResolutionResult, "writeOccurred" | "boundaries"> & { boundaries?: RuntimeBoundary[] }): ProjectResolutionResult {
  return { ...input, writeOccurred: false, boundaries: input.boundaries ?? [] };
}

export async function resolveActiveProject(
  cwd: string,
  options: ProjectResolutionOptions = {},
): Promise<ProjectResolutionResult> {
  const root = path.resolve(cwd);
  const cfg = loadPathConfig(root);
  const statePath = getStateFile(root);
  const identityPath = getProjectIdentityFile(root);
  const stateStatus = readJsonStatus<RuntimeState>(statePath);
  const localState: RuntimeState = stateStatus.ok && stateStatus.value ? stateStatus.value : loadState(root);
  const identityStatus = readJsonStatus<ProjectIdentity>(identityPath);
  const localIdentity = identityStatus.ok ? identityStatus.value : undefined;
  const localGit = readGitEvidence(root);
  let boundaries: RuntimeBoundary[];
  let paths: ProjectResolutionResult["canonicalPaths"];
  try {
    boundaries = describeRuntimeBoundaries(root, options);
    paths = canonicalPaths(root, options);
  } catch (error) {
    paths = {
      cwd: root,
      projectWorkspace: root,
      outputFolder: cfg.output_folder,
      planningArtifacts: cfg.planning_artifacts,
      implementationArtifacts: cfg.implementation_artifacts,
      projectKnowledge: cfg.project_knowledge,
      runtimeStatePath: statePath,
      projectIdentityPath: identityPath,
    };
    return result({
      confidence: "blocked",
      candidates: [],
      evidenceUsed: [evidence("cwd", "current working directory", root, { path: root })],
      rejectedCandidates: [],
      reason: `Runtime boundary/path configuration could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      nextSafeAction: "Fix Runtime Home or registry path configuration before running /bmad start.",
      writeAllowed: false,
      recoveryAction: "fix-runtime-home-or-registry-path",
      canonicalPaths: paths,
      boundaries: [],
    });
  }
  const baseEvidence: ResolutionEvidence[] = [
    evidence("cwd", "current working directory", root, { path: root }),
    evidence("state", stateStatus.exists ? (stateStatus.ok ? "local runtime state found" : "local runtime state invalid") : "local runtime state missing", stateStatus.exists ? (stateStatus.ok ? localState.phase : stateStatus.error ?? "invalid") : "missing", { path: statePath }),
    evidence("identity", identityStatus.exists ? (localIdentity?.projectId ? "local project identity found" : "local project identity invalid") : "local project identity missing", identityStatus.exists ? (localIdentity?.projectId ?? identityStatus.error ?? "invalid") : "missing", { path: identityPath, projectId: localIdentity?.projectId }),
    ...artifactEvidence(cfg),
    ...(localGit ? [evidence("git", "local git evidence found", JSON.stringify(localGit), { path: localGit.worktreePath })] : []),
    ...boundaries.map((boundary) => evidence("boundary", boundary.label, boundary.path, { path: boundary.path })),
  ];
  const localWorkspace = detectLocalWorkspace(root, cfg, identityStatus, stateStatus);

  if (stateStatus.exists && !stateStatus.ok) {
    return result({
      confidence: "blocked",
      candidates: [],
      evidenceUsed: baseEvidence,
      rejectedCandidates: [],
      reason: ".bmad-runtime/state.json exists but is invalid JSON; /bmad start must not overwrite a corrupted state file.",
      nextSafeAction: "Repair or restore .bmad-runtime/state.json before retrying /bmad start.",
      writeAllowed: false,
      recoveryAction: "repair-runtime-state-json",
      canonicalPaths: paths,
      boundaries,
    });
  }

  if (identityStatus.exists && (!identityStatus.ok || !localIdentity?.projectId)) {
    return result({
      confidence: "blocked",
      candidates: [],
      evidenceUsed: baseEvidence,
      rejectedCandidates: [],
      reason: ".bmad-runtime/project-identity.json exists but is invalid or lacks projectId; /bmad start cannot safely bind this workspace.",
      nextSafeAction: "Repair project-identity.json, then retry /bmad-start; use explicit reconcile only after confirming the intended workspace.",
      writeAllowed: false,
      recoveryAction: "repair-project-identity-json",
      canonicalPaths: paths,
      boundaries,
    });
  }

  if (identityStatus.exists && identityStatus.ok && !isProjectIdentity(localIdentity)) {
    return result({
      confidence: "blocked",
      candidates: [],
      evidenceUsed: baseEvidence,
      rejectedCandidates: [],
      reason: ".bmad-runtime/project-identity.json exists but does not match the expected schema; /bmad start cannot safely reconcile this workspace.",
      nextSafeAction: "Repair project-identity.json, then retry /bmad-start; use explicit migration/reconcile only after confirming the intended workspace.",
      writeAllowed: false,
      recoveryAction: "repair-project-identity-schema",
      canonicalPaths: paths,
      boundaries,
    });
  }

  if (stateStatus.exists && stateStatus.ok && !isRuntimeState(stateStatus.value)) {
    return result({
      confidence: "blocked",
      candidates: [],
      evidenceUsed: baseEvidence,
      rejectedCandidates: [],
      reason: ".bmad-runtime/state.json exists but does not match the expected runtime state schema; /bmad start cannot safely reconcile it.",
      nextSafeAction: "Repair .bmad-runtime/state.json, then retry /bmad-start; use explicit migration/reconcile only after confirming the intended workspace.",
      writeAllowed: false,
      recoveryAction: "repair-runtime-state-schema",
      canonicalPaths: paths,
      boundaries,
    });
  }

  const baselineStatus = readJsonStatus<Record<string, unknown>>(getBaselineLockFile(root));
  if (baselineStatus.exists && (!baselineStatus.ok || baselineStatus.value?.version !== 1)) {
    return result({
      confidence: "blocked",
      candidates: [],
      evidenceUsed: [
        ...baseEvidence,
        evidence("reconcile", "baseline lock invalid", baselineStatus.error ?? "unsupported baseline schema", { path: getBaselineLockFile(root) }),
      ],
      rejectedCandidates: [],
      reason: ".bmad-runtime/baseline-lock.json exists but is invalid or unsupported; treating it as compatible would hide migration risk.",
      nextSafeAction: "Repair baseline-lock.json before reconcile; retry /bmad-start only after the baseline is valid.",
      writeAllowed: false,
      recoveryAction: "repair-baseline-lock-json",
      canonicalPaths: paths,
      boundaries,
    });
  }

  const registry = await loadRegistry(options);
  if (!registry.ok) {
    const noRegistry = registry.error.code === "REGISTRY_NOT_FOUND";
    if (noRegistry && localWorkspace) {
      return result({
        confidence: "local_workspace_unregistered",
        candidates: [],
        evidenceUsed: [
          ...baseEvidence,
          ...localWorkspace.evidence,
          evidence("registry", "registry not found", registry.error.message),
        ],
        rejectedCandidates: [],
        reason: "A valid local BMAD workspace exists, but it is not present in the Runtime Home registry yet.",
        nextSafeAction: "Reconcile this existing workspace into the registry metadata, then re-run resolution before activation.",
        writeAllowed: false,
        recoveryAction: "reconcile-existing-workspace",
        canonicalPaths: paths,
        boundaries,
        localWorkspace,
        reconcileAllowed: true,
      });
    }
    if (noRegistry) {
      const suspicious = detectSuspiciousCwd(root, cfg, localWorkspace, [], undefined, localGit);
      if (suspicious) {
        return suspiciousBlockedResult(suspicious, {
          candidates: [],
          evidenceUsed: [
            ...baseEvidence,
            evidence("registry", "registry not found", registry.error.message),
          ],
          canonicalPaths: paths,
          boundaries,
        });
      }
      if (isGenericGitRepositoryWithoutBmadBinding(root, cfg, localWorkspace, localGit)) {
        return genericGitIntentResult({
          root,
          cfg,
          localGit,
          candidates: [],
          evidenceUsed: [...baseEvidence, evidence("registry", "registry not found", registry.error.message)],
          canonicalPaths: paths,
          boundaries,
          reason: "Generic git repository detected and no BMAD registry exists yet; /bmad start must not initialize this repository without explicit intent.",
          recoveryAction: "confirm-generic-git-repo-before-init",
        });
      }
    }
    return result({
      confidence: noRegistry ? "new_project_intent_required" : "blocked",
      candidates: [],
      evidenceUsed: [
        ...baseEvidence,
        evidence("registry", noRegistry ? "registry not found" : `registry error ${registry.error.code}`, registry.error.message),
      ],
      rejectedCandidates: [],
      reason: noRegistry
        ? "No BMAD project registry exists yet, so /bmad start cannot safely select a project or create one implicitly."
        : `BMAD project registry could not be read: ${registry.error.message}`,
      nextSafeAction: noRegistry
        ? "Run /bmad-start to select/create a project, or use /bmad init only from the intended Project Workspace for explicit repair."
        : registry.error.recoveryAction.action,
      writeAllowed: false,
      recoveryAction: noRegistry ? "explicit-project-initialization-required" : registry.error.recoveryAction.action,
      canonicalPaths: paths,
      boundaries,
    });
  }

  const registryEvidence = evidence("registry", "registry loaded read-only", `${registry.value.projects.length} projects`);
  if (registry.value.projects.length === 0) {
    if (localWorkspace) {
      return result({
        confidence: "local_workspace_unregistered",
        candidates: [],
        evidenceUsed: [...baseEvidence, ...localWorkspace.evidence, registryEvidence],
        rejectedCandidates: [],
        reason: "A valid local BMAD workspace exists, but the Runtime Home registry is empty.",
        nextSafeAction: "Reconcile this existing workspace into the registry metadata, then re-run resolution before activation.",
        writeAllowed: false,
        recoveryAction: "reconcile-existing-workspace",
        canonicalPaths: paths,
        boundaries,
        localWorkspace,
        reconcileAllowed: true,
      });
    }
    const suspicious = detectSuspiciousCwd(root, cfg, localWorkspace, [], 0, localGit);
    if (suspicious) {
      return suspiciousBlockedResult(suspicious, {
        candidates: [],
        evidenceUsed: baseEvidence,
        registryEvidence,
        canonicalPaths: paths,
        boundaries,
      });
    }
    if (isGenericGitRepositoryWithoutBmadBinding(root, cfg, localWorkspace, localGit)) {
      return genericGitIntentResult({
        root,
        cfg,
        localGit,
        candidates: [],
        evidenceUsed: baseEvidence,
        registryEvidence,
        canonicalPaths: paths,
        boundaries,
        reason: "Generic git repository detected and the BMAD registry is empty; creation requires explicit project intent.",
      });
    }
    return result({
      confidence: "new_project_intent_required",
      candidates: [],
      evidenceUsed: [...baseEvidence, registryEvidence],
      rejectedCandidates: [],
      reason: "BMAD registry is empty; /bmad start has no safe project candidate and must not create a workspace silently.",
      nextSafeAction: hasAnyArtifacts(cfg)
        ? "Run /bmad-start to reconcile/select this workspace, or use /bmad init explicitly after confirming this Project Workspace."
        : "Run /bmad-start to create/select a project, or use /bmad init explicitly from the intended Project Workspace for repair.",
      writeAllowed: false,
      recoveryAction: "explicit-project-intent-required",
      canonicalPaths: paths,
      boundaries,
    });
  }

  const candidates = registry.value.projects
    .map((project) => candidateFor(project, root, cfg, localIdentity, localGit))
    .filter((candidate): candidate is ResolutionCandidate => !!candidate)
    .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));

  if (candidates.length === 0 && localWorkspace) {
    return result({
      confidence: "local_workspace_unregistered",
      candidates: [],
      evidenceUsed: [...baseEvidence, ...localWorkspace.evidence, registryEvidence],
      rejectedCandidates: [],
      reason: "A valid local BMAD workspace exists, but no current registry project matches it.",
      nextSafeAction: "Reconcile this existing workspace into the registry metadata, then re-run resolution before activation.",
      writeAllowed: false,
      recoveryAction: "reconcile-existing-workspace",
      canonicalPaths: paths,
      boundaries,
      localWorkspace,
      reconcileAllowed: true,
    });
  }

  const conflictingGitProjects = registry.value.projects
    .map((project) => ({
      project,
      workspaceEvidence: [...identityMatches(project, localIdentity), ...pathMatches(project, root, cfg)],
      conflict: gitConflict(project, localGit),
    }))
    .filter((item) => item.workspaceEvidence.length > 0 && item.conflict);
  if (conflictingGitProjects.length > 0) {
    if (conflictingGitProjects.length === 1 && localWorkspace && localGit) {
      const conflict = conflictingGitProjects[0]!;
      const selected = candidates.find((candidate) => candidate.projectId === conflict.project.projectId);
      if (selected && localWorkspace.projectId === conflict.project.projectId) {
        return result({
          confidence: "variant_choice_required",
          selectedProjectId: selected.projectId,
          selectedProject: selected,
          candidates,
          evidenceUsed: [
            ...baseEvidence,
            registryEvidence,
            ...conflict.workspaceEvidence,
            conflict.conflict!,
            ...localWorkspace.evidence,
          ],
          rejectedCandidates: [],
          reason: `Current workspace matches project ${selected.displayName} (${selected.projectId}), but git variant evidence differs from the registry: ${conflict.conflict!.value}.`,
          nextSafeAction: "Ask the user to choose the current branch/worktree/clone variant before updating registry git evidence or writing state.",
          writeAllowed: false,
          recoveryAction: "choose-project-variant",
          canonicalPaths: paths,
          boundaries,
          localWorkspace,
        });
      }
    }
    return result({
      confidence: "blocked",
      candidates,
      evidenceUsed: [
        ...baseEvidence,
        registryEvidence,
        ...conflictingGitProjects.flatMap((item) => [...item.workspaceEvidence, item.conflict!]),
      ],
      rejectedCandidates: candidates,
      reason: `Registry/git evidence conflict for candidate(s): ${conflictingGitProjects.map((item) => item.project.displayName).join(", ")}.`,
      nextSafeAction: "Resolve registry/git conflict with explicit project selection, rebind, or variant choice before /bmad start writes state.",
      writeAllowed: false,
      recoveryAction: "resolve-registry-git-conflict-before-write",
      canonicalPaths: paths,
      boundaries,
    });
  }

  if (candidates.length === 0) {
    const suspicious = detectSuspiciousCwd(root, cfg, localWorkspace, candidates, registry.value.projects.length, localGit);
    if (suspicious) {
      return suspiciousBlockedResult(suspicious, {
        candidates,
        evidenceUsed: baseEvidence,
        registryEvidence,
        canonicalPaths: paths,
        boundaries,
      });
    }
    if (isGenericGitRepositoryWithoutBmadBinding(root, cfg, localWorkspace, localGit)) {
      return genericGitIntentResult({
        root,
        cfg,
        localGit,
        candidates,
        evidenceUsed: baseEvidence,
        registryEvidence,
        canonicalPaths: paths,
        boundaries,
      });
    }
  }

  if (candidates.length > 0) {
    const suspicious = detectSuspiciousCwd(root, cfg, localWorkspace, candidates, registry.value.projects.length, localGit);
    if (suspicious) {
      return suspiciousBlockedResult(suspicious, {
        candidates,
        evidenceUsed: [...baseEvidence, ...candidates.flatMap((candidate) => candidate.matchedBy)],
        registryEvidence,
        canonicalPaths: paths,
        boundaries,
      });
    }
  }

  const identityConflicts = localIdentity?.projectId
    ? candidates.filter((candidate) => candidate.projectId !== localIdentity.projectId && hasWorkspaceMatch(candidate))
    : [];
  if (identityConflicts.length > 0) {
    return result({
      confidence: "blocked",
      candidates,
      evidenceUsed: [...baseEvidence, registryEvidence, ...identityConflicts.flatMap((candidate) => candidate.matchedBy)],
      rejectedCandidates: identityConflicts,
      reason: `Local project identity ${localIdentity?.projectId} conflicts with registry candidate(s): ${identityConflicts.map((candidate) => candidate.projectId).join(", ")}.`,
      nextSafeAction: "Repair the registry/path alias conflict or run explicit reconcile after confirming the intended project, then retry /bmad-start.",
      writeAllowed: false,
      recoveryAction: "resolve-local-identity-registry-conflict",
      canonicalPaths: paths,
      boundaries,
    });
  }

  if (candidates.length === 1) {
    const selected = candidates[0]!;
    if (isNeedsRebindCandidate(selected, localWorkspace)) {
      return result({
        confidence: "needs_rebind",
        selectedProjectId: selected.projectId,
        selectedProject: selected,
        candidates,
        evidenceUsed: [...baseEvidence, registryEvidence, ...selected.matchedBy, ...(localWorkspace?.evidence ?? [])],
        rejectedCandidates: [],
        reason: `Local project identity matches registry project ${selected.displayName} (${selected.projectId}), but registry workspace paths point elsewhere; confirmed rebind is required before activation.`,
        nextSafeAction: "Ask the user to confirm this moved/cloned workspace, then register the current root as a known root/path alias before activation.",
        writeAllowed: false,
        recoveryAction: "confirm-workspace-rebind",
        canonicalPaths: paths,
        boundaries,
        localWorkspace,
      });
    }
    if (!isUniqueActivationCandidate(selected)) {
      if (isGenericGitRepositoryWithoutBmadBinding(root, cfg, localWorkspace, localGit)) {
        return genericGitIntentResult({
          root,
          cfg,
          localGit,
          candidates,
          rejectedCandidates: [selected],
          evidenceUsed: [...baseEvidence, registryEvidence, ...selected.matchedBy],
          canonicalPaths: paths,
          boundaries,
          reason: `Only one weak registry candidate matched (${selected.displayName}), but this git working tree has no confirmed BMAD Project Workspace/path binding; generic repo initialization requires explicit intent.`,
          recoveryAction: "confirm-generic-git-repo-before-init",
        });
      }
      return result({
        confidence: "new_project_intent_required",
        candidates,
        evidenceUsed: [...baseEvidence, registryEvidence, ...selected.matchedBy],
        rejectedCandidates: [selected],
        reason: `Only one weak registry candidate matched (${selected.displayName}), but it lacks a confirmed Project Workspace/path binding for this cwd.`,
        nextSafeAction: "Use /bmad-start project selection/details to resume or rebind, or run /bmad init only after confirming this Project Workspace.",
        writeAllowed: false,
        recoveryAction: "explicit-project-selection-required",
        canonicalPaths: paths,
        boundaries,
      });
    }
    return result({
      confidence: "unique_confident",
      selectedProjectId: selected.projectId,
      selectedProject: selected,
      candidates,
      evidenceUsed: [...baseEvidence, registryEvidence, ...selected.matchedBy],
      rejectedCandidates: [],
      reason: `Exactly one registry project matches the current workspace: ${selected.displayName} (${selected.projectId}).`,
      nextSafeAction: "Activate BMAD Runtime for the resolved project and continue from persisted state/artifacts.",
      writeAllowed: true,
      canonicalPaths: paths,
      boundaries,
    });
  }

  if (candidates.length > 1) {
    return result({
      confidence: "ambiguous",
      candidates,
      evidenceUsed: [...baseEvidence, registryEvidence, ...candidates.flatMap((candidate) => candidate.matchedBy)],
      rejectedCandidates: [],
      reason: `Multiple registry projects match this cwd (${candidates.map((candidate) => candidate.displayName).join(", ")}); /bmad start cannot choose silently.`,
      nextSafeAction: "Use the /bmad-start project picker or /bmad start details <number|name|projectId>, or resolve registry/path aliases before starting.",
      writeAllowed: false,
      recoveryAction: "explicit-project-selection-required",
      canonicalPaths: paths,
      boundaries,
    });
  }

  return result({
    confidence: "new_project_intent_required",
    candidates: [],
    evidenceUsed: [...baseEvidence, registryEvidence],
    rejectedCandidates: [],
    reason: "Registry exists, but no project record matched cwd, local identity, artifacts, or git evidence strongly enough.",
    nextSafeAction: "Run /bmad-start to select/create a project, or use /bmad init explicitly from the intended Project Workspace for repair.",
    writeAllowed: false,
    recoveryAction: "explicit-project-intent-required",
    canonicalPaths: paths,
    boundaries,
  });
}

export function shouldActivateResolvedProject(result: ProjectResolutionResult): boolean {
  return result.confidence === "unique_confident" && result.writeAllowed;
}

export function isGenericGitRepoIntentRequired(result: ProjectResolutionResult): boolean {
  return result.confidence === "new_project_intent_required" && Boolean(result.genericGitRepo) && !result.writeAllowed;
}

export function shouldBlockProjectInit(
  result: ProjectResolutionResult,
  options: { confirmGenericGitRepo?: boolean } = {},
): ProjectInitSafetyDecision {
  if (isGenericGitRepoIntentRequired(result) && !options.confirmGenericGitRepo) {
    return {
      blocked: true,
      reason: "Generic git repository requires explicit BMAD initialization intent before scaffold, artifacts, or registry writes.",
      recoveryAction: "rerun-with---confirm-generic-repo",
    };
  }
  if (["ambiguous", "blocked", "local_workspace_unregistered", "needs_rebind", "variant_choice_required"].includes(result.confidence)) {
    if (result.confidence === "local_workspace_unregistered" && result.reconcileAllowed) {
      return { blocked: false };
    }
    return {
      blocked: true,
      reason: result.reason,
      recoveryAction: result.recoveryAction,
    };
  }
  return { blocked: false };
}

export async function confirmWorkspaceRebind(
  cwd: string,
  options: ProjectResolutionOptions = {},
): Promise<WorkspaceRebindResult> {
  const root = path.resolve(cwd);
  const cfg = loadPathConfig(root);
  const resolution = await resolveActiveProject(root, options);
  if (resolution.confidence !== "needs_rebind" || !resolution.localWorkspace || !resolution.selectedProject) {
    return {
      ok: false,
      writeOccurred: false,
      projectId: resolution.selectedProjectId ?? resolution.localWorkspace?.projectId,
      touchedPaths: [],
      compatibilityEvidence: resolution.evidenceUsed,
      recoveryAction: "resolve-needs-rebind-before-confirming",
      error: "Workspace rebind requires a needs_rebind resolution with matching local identity evidence.",
    };
  }

  const existing = await loadRegistry(options);
  if (!existing.ok) {
    return {
      ok: false,
      writeOccurred: existing.error.writeOccurred,
      projectId: resolution.selectedProject.projectId,
      touchedPaths: [],
      compatibilityEvidence: resolution.evidenceUsed,
      previousKnownRoots: resolution.selectedProject.canonicalPaths.knownRoots,
      recoveryAction: existing.error.recoveryAction.action,
      error: existing.error.message,
    };
  }

  const incomingPaths = [root, cfg.output_folder, getStateFile(root)];
  const conflict = existing.value.projects.find((project) =>
    project.projectId !== resolution.selectedProject!.projectId &&
    [project.artifactRoot, project.runtimeStatePath, ...(project.knownRoots ?? []), ...(project.pathAliases ?? [])]
      .some((candidatePath) => incomingPaths.some((incoming) => pathsEquivalent(candidatePath, incoming))),
  );
  if (conflict) {
    return {
      ok: false,
      writeOccurred: false,
      projectId: resolution.selectedProject.projectId,
      touchedPaths: [],
      compatibilityEvidence: [
        ...resolution.evidenceUsed,
        evidence("registry", "conflicting registry project", conflict.projectId, { projectId: conflict.projectId }),
      ],
      previousKnownRoots: resolution.selectedProject.canonicalPaths.knownRoots,
      recoveryAction: "resolve-registry-workspace-conflict-before-rebind",
      error: `Registry project '${conflict.projectId}' already points at this workspace paths; rebind would merge metadata into the wrong project.`,
    };
  }

  const state = loadState(root);
  const registry = await upsertProjectRecord(
    registryInputForLocalWorkspace(root, cfg, resolution.localWorkspace, state),
    options,
  );
  const registryPath = (() => {
    try {
      return resolveRegistryPath(options);
    } catch {
      return undefined;
    }
  })();
  if (!registry.ok) {
    return {
      ok: false,
      writeOccurred: registry.error.writeOccurred,
      projectId: resolution.selectedProject.projectId,
      touchedPaths: registry.error.writeOccurred && registryPath ? [registryPath] : [],
      compatibilityEvidence: resolution.evidenceUsed,
      previousKnownRoots: resolution.selectedProject.canonicalPaths.knownRoots,
      recoveryAction: registry.error.recoveryAction.action,
      error: registry.error.message,
    };
  }

  return {
    ok: true,
    writeOccurred: registry.writeOccurred,
    projectId: resolution.selectedProject.projectId,
    touchedPaths: registryPath ? [registryPath] : [],
    compatibilityEvidence: resolution.evidenceUsed,
    previousKnownRoots: resolution.selectedProject.canonicalPaths.knownRoots,
    addedKnownRoot: root,
    registryProjectCount: registry.value.projects.length,
  };
}

export async function confirmProjectVariantChoice(
  cwd: string,
  options: ProjectResolutionOptions = {},
): Promise<ProjectVariantChoiceResult> {
  const root = path.resolve(cwd);
  const cfg = loadPathConfig(root);
  const resolution = await resolveActiveProject(root, options);
  const selectedGitEvidence = readGitEvidence(root);
  if (resolution.confidence !== "variant_choice_required" || !resolution.localWorkspace || !resolution.selectedProject || !selectedGitEvidence) {
    return {
      ok: false,
      writeOccurred: false,
      projectId: resolution.selectedProjectId ?? resolution.localWorkspace?.projectId,
      touchedPaths: [],
      compatibilityEvidence: resolution.evidenceUsed,
      selectedGitEvidence,
      recoveryAction: "resolve-variant-choice-before-confirming",
      error: "Project variant confirmation requires a variant_choice_required resolution with matching local workspace and git evidence.",
    };
  }

  const state = loadState(root);
  const registry = await upsertProjectRecord(
    {
      ...registryInputForLocalWorkspace(root, cfg, resolution.localWorkspace, state),
      gitEvidence: selectedGitEvidence,
    },
    options,
  );
  const registryPath = (() => {
    try {
      return resolveRegistryPath(options);
    } catch {
      return undefined;
    }
  })();
  if (!registry.ok) {
    return {
      ok: false,
      writeOccurred: registry.error.writeOccurred,
      projectId: resolution.selectedProject.projectId,
      touchedPaths: registry.error.writeOccurred && registryPath ? [registryPath] : [],
      compatibilityEvidence: resolution.evidenceUsed,
      previousGitEvidence: resolution.selectedProject.gitEvidence,
      selectedGitEvidence,
      recoveryAction: registry.error.recoveryAction.action,
      error: registry.error.message,
    };
  }

  return {
    ok: true,
    writeOccurred: registry.writeOccurred,
    projectId: resolution.selectedProject.projectId,
    touchedPaths: registryPath ? [registryPath] : [],
    compatibilityEvidence: resolution.evidenceUsed,
    previousGitEvidence: resolution.selectedProject.gitEvidence,
    selectedGitEvidence,
    registryProjectCount: registry.value.projects.length,
  };
}

function parseTime(value: string | undefined): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function matchSummary(candidate: ResolutionCandidate): string {
  const labels = uniqueStrings(candidate.matchedBy.map((item) => item.label));
  const friendly = labels.map((label) =>
    label
      .replace("local project identity matches registry projectId", "stable id")
      .replace("knownRoot matches cwd", "known root")
      .replace("pathAlias matches cwd", "path alias")
      .replace("artifactRoot matches output_folder", "artifact root")
      .replace("runtimeStatePath matches local state", "runtime state")
      .replace("git remote fingerprint matches", "git remote")
      .replace("git worktree path matches", "git worktree"),
  );
  return friendly.slice(0, 3).join(" + ") || "candidate evidence";
}

export function buildNameFirstProjectPicker(candidates: ResolutionCandidate[]): ProjectPickerOption[] {
  return candidates
    .slice()
    .sort((a, b) => b.score - a.score || parseTime(b.lastSeenAt) - parseTime(a.lastSeenAt) || a.displayName.localeCompare(b.displayName))
    .map((candidate, index) => ({
      index: index + 1,
      projectId: candidate.projectId,
      displayName: candidate.displayName,
      score: candidate.score,
      lastSeenAt: candidate.lastSeenAt,
      status: candidate.status,
      matchSummary: matchSummary(candidate),
    }));
}

export function formatNameFirstProjectPicker(result: ProjectResolutionResult): string {
  if (result.confidence !== "ambiguous" || result.candidates.length === 0) return "";
  const lines = ["## Name-First Project Picker", ""];
  for (const option of buildNameFirstProjectPicker(result.candidates)) {
    lines.push(`${option.index}. ${option.displayName}`);
  }
  lines.push("", "Details: /bmad start details <number|name|projectId>");
  lines.push("Selection remains conversational through /bmad-start or /bmad start; writes occur only after an explicit user choice.");
  return lines.join("\n");
}

function normalizeSelector(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function findPickerCandidate(result: ProjectResolutionResult, selector: string): { candidate?: ResolutionCandidate; index?: number; ambiguous?: boolean } {
  const trimmed = selector.trim().replace(/\s+/g, " ");
  if (!trimmed) return {};
  const picker = buildNameFirstProjectPicker(result.candidates);
  if (/^[1-9]\d*$/.test(trimmed)) {
    const numeric = Number(trimmed);
    const option = picker.find((item) => item.index === numeric);
    return option ? { candidate: result.candidates.find((candidate) => candidate.projectId === option.projectId), index: option.index } : {};
  }
  const lowered = normalizeSelector(trimmed);
  const exactId = result.candidates.find((item) => normalizeSelector(item.projectId) === lowered);
  if (exactId) {
    const option = picker.find((item) => item.projectId === exactId.projectId);
    return { candidate: exactId, index: option?.index };
  }
  const nameMatches = result.candidates.filter((item) =>
    normalizeSelector(item.displayName) === lowered ||
    item.historicalAliases.some((alias) => normalizeSelector(alias) === lowered),
  );
  if (nameMatches.length > 1) return { ambiguous: true };
  const candidate = nameMatches[0];
  const option = candidate ? picker.find((item) => item.projectId === candidate.projectId) : undefined;
  return { candidate, index: option?.index };
}

export function formatProjectPickerDetails(result: ProjectResolutionResult, selector: string, cwd = result.canonicalPaths.cwd): string {
  if (result.confidence !== "ambiguous") {
    return [
      "## Project Picker Details",
      "",
      "Project picker details are available only for ambiguous resolution results.",
      "No state or registry decision was recorded.",
    ].join("\n");
  }
  const { candidate, index, ambiguous } = findPickerCandidate(result, selector);
  if (ambiguous) {
    return [
      "## Project Picker Details",
      "",
      `Selector '${selector}' matches multiple picker items.`,
      "Use the item number or Stable ID from the Name-First Project Picker.",
      "No state or registry decision was recorded.",
    ].join("\n");
  }
  if (!candidate) {
    return [
      "## Project Picker Details",
      "",
      `No picker item matched '${selector}'.`,
      "Use /bmad start details <number|name|projectId> with a value from the Name-First Project Picker.",
    ].join("\n");
  }
  const git = candidate.gitEvidence;
  return [
    "## Project Picker Details",
    "",
    `Item: ${index ?? "?"}`,
    `Display name: ${candidate.displayName}`,
    `Stable ID: ${candidate.projectId}`,
    `Historical aliases: ${candidate.historicalAliases.join(", ") || "none"}`,
    `Path aliases: ${candidate.canonicalPaths.pathAliases.map((item) => path.isAbsolute(item) ? toProjectRelative(cwd, item) : item).join(", ") || "none"}`,
    `Known roots: ${candidate.canonicalPaths.knownRoots.map((item) => toProjectRelative(cwd, item)).join(", ") || "none"}`,
    `Artifact root: ${toProjectRelative(cwd, candidate.canonicalPaths.artifactRoot)}`,
    `Runtime state: ${toProjectRelative(cwd, candidate.canonicalPaths.runtimeStatePath)}`,
    `Phase: ${candidate.phase ?? "unknown"}`,
    `Status: ${candidate.status ?? "unknown"}`,
    `Current workflow: ${candidate.currentWorkflow ?? "none"}`,
    `Current story: ${candidate.currentStory ?? "none"}`,
    `Last activity: ${candidate.lastSeenAt ?? "unknown"}`,
    "Git evidence:",
    `- remote fingerprint: ${git?.remoteUrlFingerprint ?? "none"}`,
    `- branch: ${git?.branch ?? "none"}`,
    `- worktree: ${git?.worktreePath ? toProjectRelative(cwd, git.worktreePath) : "none"}`,
    `- commit: ${git?.commit ?? "none"}`,
    `Matched by: ${matchSummary(candidate)}`,
    "Decision persistence: read-only details request; no state or registry decision is recorded.",
  ].join("\n");
}

export async function reconcileExistingWorkspace(
  cwd: string,
  options: ProjectResolutionOptions = {},
): Promise<WorkspaceReconcileResult> {
  const root = path.resolve(cwd);
  const cfg = loadPathConfig(root);
  const stateStatus = readJsonStatus<RuntimeState>(getStateFile(root));
  const identityStatus = readJsonStatus<ProjectIdentity>(getProjectIdentityFile(root));
  if (stateStatus.exists && !stateStatus.ok) {
    return {
      ok: false,
      writeOccurred: false,
      touchedPaths: [],
      compatibilityEvidence: [evidence("state", "invalid runtime state", stateStatus.error ?? "invalid", { path: getStateFile(root) })],
      recoveryAction: "repair-runtime-state-json",
      error: ".bmad-runtime/state.json is invalid; reconcile would risk preserving incorrect state metadata.",
    };
  }
  if (stateStatus.exists && stateStatus.ok && !isRuntimeState(stateStatus.value)) {
    return {
      ok: false,
      writeOccurred: false,
      touchedPaths: [],
      compatibilityEvidence: [evidence("state", "invalid runtime state schema", "unsupported", { path: getStateFile(root) })],
      recoveryAction: "repair-runtime-state-schema",
      error: ".bmad-runtime/state.json schema is invalid; reconcile requires compatible runtime state metadata.",
    };
  }
  const baselineStatus = readJsonStatus<Record<string, unknown>>(getBaselineLockFile(root));
  if (baselineStatus.exists && (!baselineStatus.ok || baselineStatus.value?.version !== 1)) {
    return {
      ok: false,
      writeOccurred: false,
      touchedPaths: [],
      compatibilityEvidence: [evidence("reconcile", "invalid baseline lock", baselineStatus.error ?? "unsupported baseline schema", { path: getBaselineLockFile(root) })],
      recoveryAction: "repair-baseline-lock-json",
      error: ".bmad-runtime/baseline-lock.json is invalid or unsupported; reconcile requires repair or explicit migration.",
    };
  }
  const localWorkspace = detectLocalWorkspace(root, cfg, identityStatus, stateStatus);
  if (!localWorkspace) {
    return {
      ok: false,
      writeOccurred: false,
      touchedPaths: [],
      compatibilityEvidence: [
        evidence("identity", identityStatus.exists ? "invalid project identity" : "missing project identity", identityStatus.error ?? "missing", { path: getProjectIdentityFile(root) }),
        evidence("artifacts", fs.existsSync(cfg.output_folder) ? "artifact root found" : "artifact root missing", cfg.output_folder, { path: cfg.output_folder }),
      ],
      recoveryAction: "repair-existing-workspace-before-reconcile",
      error: "Existing workspace reconcile requires a valid project identity and existing artifact root.",
    };
  }

  const state = stateStatus.ok && stateStatus.value ? stateStatus.value : loadState(root);
  const input = registryInputForLocalWorkspace(root, cfg, localWorkspace, state);
  const existing = await loadRegistry(options);
  if (existing.ok) {
    const incomingPaths = [root, cfg.output_folder, getStateFile(root)];
    const conflict = existing.value.projects.find((project) =>
      project.projectId !== localWorkspace.projectId &&
      [project.artifactRoot, project.runtimeStatePath, ...(project.knownRoots ?? []), ...(project.pathAliases ?? [])]
        .some((candidatePath) => incomingPaths.some((incoming) => pathsEquivalent(candidatePath, incoming))),
    );
    if (conflict) {
      return {
        ok: false,
        writeOccurred: false,
        projectId: localWorkspace.projectId,
        touchedPaths: [],
        compatibilityEvidence: [
          ...localWorkspace.evidence,
          evidence("registry", "conflicting registry project", conflict.projectId, { projectId: conflict.projectId }),
        ],
        recoveryAction: "resolve-registry-workspace-conflict-before-reconcile",
        error: `Registry project '${conflict.projectId}' already points at this workspace paths; reconcile would merge metadata into the wrong project.`,
      };
    }
  } else if (existing.error.code !== "REGISTRY_NOT_FOUND") {
    return {
      ok: false,
      writeOccurred: existing.error.writeOccurred,
      projectId: localWorkspace.projectId,
      touchedPaths: [],
      compatibilityEvidence: localWorkspace.evidence,
      recoveryAction: existing.error.recoveryAction.action,
      error: existing.error.message,
    };
  }
  const registry = await upsertProjectRecord(input, options);
  const registryPath = (() => {
    try {
      return resolveRegistryPath(options);
    } catch {
      return undefined;
    }
  })();
  if (!registry.ok) {
    return {
      ok: false,
      writeOccurred: registry.error.writeOccurred,
      projectId: localWorkspace.projectId,
      touchedPaths: registry.error.writeOccurred && registryPath ? [registryPath] : [],
      compatibilityEvidence: localWorkspace.evidence,
      recoveryAction: registry.error.recoveryAction.action,
      error: registry.error.message,
    };
  }
  return {
    ok: true,
    writeOccurred: registry.writeOccurred,
    projectId: localWorkspace.projectId,
    touchedPaths: registryPath ? [registryPath] : [],
    compatibilityEvidence: localWorkspace.evidence,
    registryProjectCount: registry.value.projects.length,
  };
}

function resolutionActionFor(result: ProjectResolutionResult): ResolutionAction {
  if (result.confidence === "unique_confident" && result.writeAllowed && (result.selectedProject || result.selectedProjectId)) return "activate_resolved_project";
  if (result.confidence === "ambiguous") return "show_project_picker";
  if (result.confidence === "needs_rebind") return "confirm_workspace_rebind";
  if (result.confidence === "variant_choice_required") return "choose_project_variant";
  if (result.confidence === "local_workspace_unregistered" && result.reconcileAllowed) return "reconcile_existing_workspace";
  if (result.confidence === "new_project_intent_required") return "require_explicit_project_intent";
  if (result.recoveryAction) return "repair_before_retry";
  return "block_resolution";
}

function safeRecoveryStatusFor(result: ProjectResolutionResult): ResolutionExplanation["safeRecoveryStatus"] {
  if (result.confidence === "unique_confident" && result.writeAllowed) return "not_required";
  return result.recoveryAction ? "yes" : "no";
}

function formatEvidenceSummary(cwd: string, item: ResolutionEvidence, includeTechnicalValue: boolean): string {
  const project = item.projectId ? ` [${item.projectId}]` : "";
  if (!includeTechnicalValue) return `- ${item.kind}: ${item.label}`;
  return formatEvidenceLine(cwd, item);
}

function rejectedReason(result: ProjectResolutionResult, candidate: ResolutionCandidate): string {
  if (result.confidence === "new_project_intent_required") {
    return "candidate lacks a confirmed Project Workspace/path binding or explicit project intent";
  }
  if (result.confidence === "blocked") return result.reason;
  if (result.confidence === "ambiguous") return "not rejected; explicit selection is required before activation";
  if (result.selectedProjectId && candidate.projectId !== result.selectedProjectId) return "not selected because another candidate had stronger evidence";
  return result.reason;
}

function formatRejectedCandidate(result: ProjectResolutionResult, candidate: ResolutionCandidate): string {
  return `- ${candidate.displayName} (${candidate.projectId}) — score ${candidate.score}; ${rejectedReason(result, candidate)}`;
}

export function buildResolutionExplanation(result: ProjectResolutionResult, cwd = result.canonicalPaths.cwd): ResolutionExplanation {
  const includeTechnicalEvidence = result.confidence !== "ambiguous";
  return {
    action: resolutionActionFor(result),
    confidenceReason: result.reason,
    evidenceUsed: result.evidenceUsed.length > 0
      ? result.evidenceUsed.map((item) => formatEvidenceSummary(cwd, item, includeTechnicalEvidence))
      : ["- none"],
    rejectedAlternatives: result.rejectedCandidates.length > 0
      ? result.rejectedCandidates.map((candidate) => formatRejectedCandidate(result, candidate))
      : ["- none"],
    writeOccurred: result.writeOccurred,
    recoveryAction: result.recoveryAction,
    safeRecoveryStatus: safeRecoveryStatusFor(result),
    nextSafeAction: result.nextSafeAction,
  };
}

export function formatResolutionExplanation(result: ProjectResolutionResult, cwd = result.canonicalPaths.cwd): string {
  const explanation = buildResolutionExplanation(result, cwd);
  const lines = [
    "## Resolution Explanation",
    "",
    `Action: ${explanation.action}`,
    `Confidence reason: ${explanation.confidenceReason}`,
    "Evidence used:",
    ...explanation.evidenceUsed,
    "Rejected alternatives:",
    ...explanation.rejectedAlternatives,
    `Write occurred: ${explanation.writeOccurred}`,
    `Recovery action: ${explanation.recoveryAction ?? "none"}`,
    `Safe recovery available: ${explanation.safeRecoveryStatus}`,
  ];
  if (explanation.safeRecoveryStatus === "no") {
    lines.push("No safe recovery action is available; stop and repair the blocking condition before retrying.");
  }
  lines.push(`Next safe action: ${explanation.safeRecoveryStatus === "no" ? "none; stop and repair the blocking condition before retrying" : explanation.nextSafeAction}`);
  return lines.join("\n");
}

function formatEvidenceLine(cwd: string, item: ResolutionEvidence): string {
  const displayPath = item.path ? toProjectRelative(cwd, item.path) : undefined;
  const value = displayPath && displayPath !== item.value ? `${item.value} (${displayPath})` : item.value;
  const project = item.projectId ? ` [${item.projectId}]` : "";
  return `- ${item.kind}: ${item.label}${project} — ${value}`;
}

export function formatResolutionResult(result: ProjectResolutionResult, cwd = result.canonicalPaths.cwd): string {
  const formattedBoundaries = result.boundaries.length > 0
    ? formatRuntimeBoundaries(result.boundaries, cwd)
    : "# Runtime Boundaries\n\n- unavailable: boundary resolution failed; see blocked recovery action above.";
  const lines = [
    "# BMAD Active Project Resolution",
    "",
    `Confidence: ${result.confidence}`,
    `Write allowed: ${result.writeAllowed}`,
    `Write occurred: ${result.writeOccurred}`,
    `Reason: ${result.reason}`,
    `Next safe action: ${result.nextSafeAction}`,
  ];
  if (result.recoveryAction) lines.push(`Recovery: ${result.recoveryAction}`);
  lines.push("", formatResolutionExplanation(result, cwd));
  if (result.selectedProject) {
    lines.push("", "## Selected Project", "", `- ${result.selectedProject.displayName} (${result.selectedProject.projectId})`, `- Score: ${result.selectedProject.score}`);
  }
  if (result.localWorkspace) {
    lines.push(
      "",
      "## Local Workspace Candidate",
      "",
      `- ${result.localWorkspace.displayName} (${result.localWorkspace.projectId})`,
      `- Compatibility: ${result.localWorkspace.compatibility}`,
      `- Artifact root: ${toProjectRelative(cwd, result.localWorkspace.artifactRoot)}`,
      `- Runtime state: ${toProjectRelative(cwd, result.localWorkspace.runtimeStatePath)}`,
      `- Reconcile allowed: ${result.reconcileAllowed === true}`,
    );
  }
  if (result.suspiciousCwd) {
    const affectedPath = toProjectRelative(cwd, result.suspiciousCwd.affectedPath) || result.suspiciousCwd.affectedPath;
    lines.push(
      "",
      "## Suspicious CWD Block",
      "",
      `- Affected path: ${affectedPath}`,
      `- Causes: ${result.suspiciousCwd.reasons.join("; ")}`,
      `- Write occurred: ${result.writeOccurred}`,
      `- Recovery: ${result.suspiciousCwd.recoveryAction}`,
    );
  }
  if (result.genericGitRepo) {
    lines.push(
      "",
      "## Generic Git Repository Intent Required",
      "",
      `- Worktree: ${toProjectRelative(cwd, result.genericGitRepo.worktreePath) || result.genericGitRepo.worktreePath}`,
      `- Branch: ${result.genericGitRepo.branch ?? "unknown"}`,
      `- Commit: ${result.genericGitRepo.commit ?? "unknown"}`,
      `- Remote fingerprint: ${result.genericGitRepo.remoteUrlFingerprint ?? "none"}`,
      `- Write occurred: ${result.writeOccurred}`,
      "- Required confirmation: /bmad init --confirm-generic-repo",
    );
  }
  if (result.candidates.length > 0 && result.confidence !== "ambiguous") {
    lines.push("", "## Candidates", "");
    for (const candidate of result.candidates) {
      lines.push(`- ${candidate.displayName} (${candidate.projectId}) — score ${candidate.score}`);
      lines.push(`  - Artifact root: ${toProjectRelative(cwd, candidate.canonicalPaths.artifactRoot)}`);
      lines.push(`  - Runtime state: ${toProjectRelative(cwd, candidate.canonicalPaths.runtimeStatePath)}`);
    }
  }
  const picker = formatNameFirstProjectPicker(result);
  if (picker) lines.push("", picker);
  if (result.confidence === "ambiguous") {
    lines.push(
      "",
      "Evidence summary: multiple plausible projects matched local evidence. Technical details are available on demand only.",
      "Write gate: blocked until explicit selection, rebind, or variant choice.",
    );
    return lines.join("\n");
  }
  lines.push("", "## Evidence Used", "", ...result.evidenceUsed.map((item) => formatEvidenceLine(cwd, item)));
  lines.push(
    "",
    "## Canonical Paths",
    "",
    `- Project Workspace: ${toProjectRelative(cwd, result.canonicalPaths.projectWorkspace)}`,
    `- Output Folder: ${toProjectRelative(cwd, result.canonicalPaths.outputFolder)}`,
    `- Runtime State: ${toProjectRelative(cwd, result.canonicalPaths.runtimeStatePath)}`,
    `- Project Identity: ${toProjectRelative(cwd, result.canonicalPaths.projectIdentityPath)}`,
    result.canonicalPaths.registryPath ? `- Registry: ${toProjectRelative(cwd, result.canonicalPaths.registryPath)}` : "- Registry: default Runtime Home registry",
    ...(result.selectedProject
      ? [
          `- Selected Artifact Root: ${toProjectRelative(cwd, result.selectedProject.canonicalPaths.artifactRoot)}`,
          `- Selected Runtime State: ${toProjectRelative(cwd, result.selectedProject.canonicalPaths.runtimeStatePath)}`,
          `- Selected Known Roots: ${result.selectedProject.canonicalPaths.knownRoots.map((item) => toProjectRelative(cwd, item)).join(", ") || "none"}`,
          `- Selected Path Aliases: ${result.selectedProject.canonicalPaths.pathAliases.map((item) => path.isAbsolute(item) ? toProjectRelative(cwd, item) : item).join(", ") || "none"}`,
        ]
      : []),
    "",
    formattedBoundaries,
  );
  return lines.join("\n");
}
