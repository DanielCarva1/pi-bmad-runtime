import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const REGISTRY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_RUNTIME_HOME = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "bmad-runtime",
);
export const DEFAULT_REGISTRY_FILE = "projects.json";

export const FORBIDDEN_CANONICAL_REGISTRY_FIELDS = [
  "prd",
  "architecture",
  "epic",
  "epics",
  "story",
  "stories",
  "evidence",
  "body",
  "content",
  "artifactContent",
  "artifact_content",
  "artifactBody",
  "artifact_body",
  "prdContent",
  "architectureContent",
  "storyContent",
  "storiesContent",
  "decisions",
  "decision",
] as const;

const FORBIDDEN_FIELD_SET = new Set(
  FORBIDDEN_CANONICAL_REGISTRY_FIELDS.map((field) => field.toLowerCase()),
);

const ALLOWED_METADATA_FIELD_SET = new Set(
  [
    "schemaVersion",
    "projects",
    "updatedAt",
    "recovery",
    "action",
    "reason",
    "timestamp",
    "backupPath",
    "projectId",
    "displayName",
    "historicalAliases",
    "knownRoots",
    "artifactRoot",
    "runtimeStatePath",
    "pathAliases",
    "activeVersion",
    "phase",
    "status",
    "currentWorkflow",
    "currentStory",
    "readinessState",
    "lastWorkflow",
    "lastSeenAt",
    "gitEvidence",
    "targetRepos",
    "remoteUrlFingerprint",
    "branch",
    "worktreePath",
    "commit",
    "role",
    "path",
  ].map((field) => field.toLowerCase()),
);

const REGISTRY_ROOT_FIELDS = new Set([
  "schemaVersion",
  "projects",
  "updatedAt",
  "recovery",
]);
const RECOVERY_ACTION_FIELDS = new Set([
  "action",
  "reason",
  "timestamp",
  "backupPath",
]);
const PROJECT_RECORD_FIELDS = new Set([
  "projectId",
  "displayName",
  "historicalAliases",
  "knownRoots",
  "artifactRoot",
  "runtimeStatePath",
  "pathAliases",
  "activeVersion",
  "phase",
  "status",
  "currentWorkflow",
  "currentStory",
  "readinessState",
  "lastWorkflow",
  "lastSeenAt",
  "gitEvidence",
  "targetRepos",
]);
const GIT_EVIDENCE_FIELDS = new Set([
  "remoteUrlFingerprint",
  "branch",
  "worktreePath",
  "commit",
]);
const TARGET_REPO_FIELDS = new Set(["role", "path"]);
const MAX_CANONICAL_FIELD_SCAN_DEPTH = 80;
const REGISTRY_LOCK_WAIT_TIMEOUT_MS = 4_000;

export interface GitEvidence {
  remoteUrlFingerprint?: string;
  branch?: string;
  worktreePath?: string;
  commit?: string;
}

export interface TargetRepoPointer {
  role: string;
  path: string;
}

export interface ProjectRegistryRecord {
  projectId: string;
  displayName: string;
  historicalAliases: string[];
  knownRoots: string[];
  artifactRoot: string;
  runtimeStatePath: string;
  pathAliases: string[];
  activeVersion?: string;
  phase?: string;
  status?: string;
  currentWorkflow?: string | null;
  currentStory?: string | null;
  readinessState?: string;
  lastWorkflow?: string;
  lastSeenAt: string;
  gitEvidence?: GitEvidence;
  targetRepos?: TargetRepoPointer[];
}

export interface BmadProjectRegistry {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  projects: ProjectRegistryRecord[];
  updatedAt?: string;
  recovery?: RecoveryAction;
}

export type ProjectRegistryInput = Partial<ProjectRegistryRecord> & {
  displayName: string;
  knownRoots?: string[];
  artifactRoot: string;
  runtimeStatePath: string;
  pathAliases?: string[];
  lastSeenAt?: string;
};

export interface ProjectRenameInput {
  projectId: string;
  displayName: string;
}

export interface ProjectRenameSummary {
  projectId: string;
  previousDisplayName: string;
  displayName: string;
  addedHistoricalAlias?: string;
}

export type ProjectRenameResult = RegistryOperationResult<{
  registry: BmadProjectRegistry;
  rename: ProjectRenameSummary;
}>;

export type ProjectDisplayNameAvailabilityResult = RegistryOperationResult<{
  projectId: string;
  displayName: string;
}>;

export interface ProjectPathAliasInput {
  projectId: string;
  pathAlias: string;
  knownRoot?: boolean;
}

export type ProjectPathAliasResult = RegistryOperationResult<{
  registry: BmadProjectRegistry;
  projectId: string;
  pathAlias: string;
  added: boolean;
}>;

export type RegistryErrorCode =
  | "REGISTRY_NOT_FOUND"
  | "REGISTRY_PROJECT_NOT_FOUND"
  | "REGISTRY_NAME_COLLISION"
  | "REGISTRY_PATH_ALIAS_CONFLICT"
  | "REGISTRY_JSON_INVALID"
  | "REGISTRY_SCHEMA_MISSING"
  | "REGISTRY_SCHEMA_UNSUPPORTED"
  | "REGISTRY_INVALID_SHAPE"
  | "REGISTRY_RUNTIME_HOME_INVALID"
  | "CANONICAL_CONTENT_FIELD_REJECTED"
  | "REGISTRY_WRITE_FAILED"
  | "REGISTRY_LOCK_UNAVAILABLE";

export interface RecoveryAction {
  action: string;
  reason: string;
  timestamp: string;
  backupPath?: string;
}

export interface RegistryOperationError {
  code: RegistryErrorCode;
  message: string;
  writeOccurred: boolean;
  recoveryAction: RecoveryAction;
  cause?: string;
}

export interface RegistryOperationSuccess<T> {
  ok: true;
  value: T;
  writeOccurred: boolean;
  recoveryAction?: RecoveryAction;
}

export interface RegistryOperationFailure {
  ok: false;
  error: RegistryOperationError;
}

export type RegistryOperationResult<T> =
  | RegistryOperationSuccess<T>
  | RegistryOperationFailure;

export interface RegistryMutationHooks {
  afterTempWrite?: (context: {
    tempPath: string;
    registryPath: string;
    backupPath: string;
  }) => void | Promise<void>;
  beforeReplace?: (context: {
    tempPath: string;
    registryPath: string;
    backupPath: string;
  }) => void | Promise<void>;
}

export interface RegistryOptions {
  runtimeHome?: string;
  registryPath?: string;
  hooks?: RegistryMutationHooks;
}

export interface RegistrySchemaMigrationSummary {
  registryPath: string;
  from: "absent" | "missing-schema" | "current";
  toSchemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  backupPath?: string;
}

export type RegistrySchemaMigrationResult = RegistryOperationResult<{
  registry: BmadProjectRegistry;
  migration: RegistrySchemaMigrationSummary;
}>;

const mutationQueues = new Map<string, Promise<unknown>>();

function nowIso(): string {
  return new Date().toISOString();
}

function recovery(
  action: string,
  reason: string,
  backupPath?: string,
): RecoveryAction {
  const base: RecoveryAction = { action, reason, timestamp: nowIso() };
  return backupPath ? { ...base, backupPath } : base;
}

function failure(
  code: RegistryErrorCode,
  message: string,
  recoveryAction: RecoveryAction,
  options: { writeOccurred?: boolean; cause?: unknown } = {},
): RegistryOperationFailure {
  const error: RegistryOperationError = {
    code,
    message,
    writeOccurred: options.writeOccurred ?? false,
    recoveryAction,
  };
  if (options.cause instanceof Error) error.cause = options.cause.message;
  else if (typeof options.cause === "string") error.cause = options.cause;
  return { ok: false, error };
}

function preserveFailure(
  error: RegistryOperationError,
  writeOccurred: boolean,
): RegistryOperationFailure {
  return failure(error.code, error.message, error.recoveryAction, {
    writeOccurred,
    cause: error.cause,
  });
}

function success<T>(
  value: T,
  writeOccurred: boolean,
  recoveryAction?: RecoveryAction,
): RegistryOperationSuccess<T> {
  return recoveryAction
    ? { ok: true, value, writeOccurred, recoveryAction }
    : { ok: true, value, writeOccurred };
}

export function resolveRegistryPath(options: RegistryOptions = {}): string {
  if (options.registryPath !== undefined) {
    if (options.registryPath.trim().length === 0)
      throw new Error("Registry path must not be empty.");
    return path.normalize(options.registryPath);
  }
  if (
    options.runtimeHome !== undefined &&
    options.runtimeHome.trim().length === 0
  ) {
    throw new Error("Runtime Home must not be empty.");
  }
  return path.join(
    path.normalize(options.runtimeHome ?? DEFAULT_RUNTIME_HOME),
    DEFAULT_REGISTRY_FILE,
  );
}

function resolveRegistryPathResult(
  options: RegistryOptions = {},
): RegistryOperationResult<string> {
  if (
    options.registryPath !== undefined &&
    options.registryPath.trim().length === 0
  ) {
    return failure(
      "REGISTRY_RUNTIME_HOME_INVALID",
      "Registry path must not be empty.",
      recovery(
        "provide-non-empty-runtime-home-or-registry-path",
        "Empty registryPath would resolve outside the intended Runtime Home.",
      ),
    );
  }
  if (
    options.runtimeHome !== undefined &&
    options.runtimeHome.trim().length === 0 &&
    options.registryPath === undefined
  ) {
    return failure(
      "REGISTRY_RUNTIME_HOME_INVALID",
      "Runtime Home must not be empty.",
      recovery(
        "provide-non-empty-runtime-home-or-registry-path",
        "Empty runtimeHome would resolve projects.json in the current working directory.",
      ),
    );
  }
  return success(resolveRegistryPath(options), false);
}

function emptyRegistry(): BmadProjectRegistry {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, projects: [] };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return optionalString(value);
}

function requiredNonEmptyString(
  raw: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = optionalString(raw[field]);
  return value && value.trim().length > 0 ? value : undefined;
}

function stringArray(
  raw: Record<string, unknown>,
  field: string,
): RegistryOperationResult<string[]> {
  if (!hasOwn(raw, field)) return success([], false);
  const value = raw[field];
  if (!Array.isArray(value)) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      `Project registry field ${field} must be an array of strings.`,
      recovery("fix-registry-shape-before-retry", `${field} was not an array.`),
    );
  }
  if (!value.every((item): item is string => typeof item === "string")) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      `Project registry field ${field} must contain only strings.`,
      recovery(
        "fix-registry-shape-before-retry",
        `${field} contained a non-string item.`,
      ),
    );
  }
  if (value.some((item) => item.trim().length === 0)) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      `Project registry field ${field} must not contain empty or whitespace-only entries.`,
      recovery(
        "fix-registry-shape-before-retry",
        `${field} contained an empty or whitespace-only item.`,
      ),
    );
  }
  return success(value, false);
}

function validTimestamp(value: string): boolean {
  return value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function assertKnownFields(
  raw: Record<string, unknown>,
  allowed: Set<string>,
  location: string,
): RegistryOperationFailure | undefined {
  for (const key of Object.keys(raw)) {
    if (allowed.has(key)) continue;
    return failure(
      "REGISTRY_INVALID_SHAPE",
      `${location} contains unsupported registry field '${key}'.`,
      recovery(
        "remove-unsupported-registry-field-before-retry",
        `Unsupported field '${key}' was found at ${location}.`,
      ),
    );
  }
  return undefined;
}

function rejectCanonicalFields(
  value: unknown,
  location = "$",
  seen = new WeakSet<object>(),
  depth = 0,
): RegistryOperationFailure | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (depth > MAX_CANONICAL_FIELD_SCAN_DEPTH) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      `Registry metadata nesting at ${location} exceeds the supported validation depth.`,
      recovery(
        "fix-registry-shape-before-retry",
        `Nesting deeper than ${MAX_CANONICAL_FIELD_SCAN_DEPTH} levels was found at ${location}.`,
      ),
    );
  }
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = rejectCanonicalFields(
        value[index],
        `${location}[${index}]`,
        seen,
        depth + 1,
      );
      if (nested) return nested;
    }
    return undefined;
  }

  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const normalizedKey = key.toLowerCase();
    const forbiddenCanonicalField =
      !ALLOWED_METADATA_FIELD_SET.has(normalizedKey) &&
      (FORBIDDEN_FIELD_SET.has(normalizedKey) ||
        FORBIDDEN_CANONICAL_REGISTRY_FIELDS.some((field) =>
          normalizedKey.includes(field.toLowerCase()),
        ));
    if (forbiddenCanonicalField) {
      return failure(
        "CANONICAL_CONTENT_FIELD_REJECTED",
        `Registry is metadata-only; canonical content field '${key}' at ${location} is forbidden.`,
        recovery(
          "remove-canonical-content-and-store-only-pointers",
          `Forbidden field '${key}' found at ${location}.`,
        ),
      );
    }
    const nested = rejectCanonicalFields(
      nestedValue,
      `${location}.${key}`,
      seen,
      depth + 1,
    );
    if (nested) return nested;
  }
  return undefined;
}

function optionalMetadataString(
  raw: Record<string, unknown>,
  field: string,
  location: string,
): RegistryOperationResult<string | undefined> {
  if (!hasOwn(raw, field)) return success(undefined, false);
  const value = raw[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      `${location}.${field} must be a non-empty string when provided.`,
      recovery(
        "fix-registry-shape-before-retry",
        `${location}.${field} was missing, empty, or not a string.`,
      ),
    );
  }
  return success(value, false);
}

function requiredMetadataString(
  raw: Record<string, unknown>,
  field: string,
  location: string,
): RegistryOperationResult<string> {
  if (!hasOwn(raw, field)) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      `${location}.${field} must be a non-empty string.`,
      recovery(
        "fix-registry-shape-before-retry",
        `${location}.${field} was missing.`,
      ),
    );
  }
  const value = optionalMetadataString(raw, field, location);
  if (!value.ok) return value;
  return success(value.value!, false);
}

function optionalNullableMetadataString(
  raw: Record<string, unknown>,
  field: string,
  location: string,
): RegistryOperationResult<string | null | undefined> {
  if (!hasOwn(raw, field)) return success(undefined, false);
  if (raw[field] === null) return success(null, false);
  return optionalMetadataString(raw, field, location);
}

function optionalTimestampString(
  raw: Record<string, unknown>,
  field: string,
  location: string,
): RegistryOperationResult<string | undefined> {
  const value = optionalMetadataString(raw, field, location);
  if (!value.ok || value.value === undefined) return value;
  if (!validTimestamp(value.value)) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      `${location}.${field} must be a valid timestamp when provided.`,
      recovery(
        "fix-registry-shape-before-retry",
        `${location}.${field} was not a valid timestamp.`,
      ),
    );
  }
  return value;
}

function normalizeRecoveryAction(
  value: unknown,
): RegistryOperationResult<RecoveryAction | undefined> {
  const raw = asRecord(value);
  if (!raw) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "Registry field recovery must be an object when provided.",
      recovery("fix-registry-shape-before-retry", "recovery was not an object."),
    );
  }
  const unknown = assertKnownFields(raw, RECOVERY_ACTION_FIELDS, "recovery");
  if (unknown) return unknown;

  const action = requiredMetadataString(raw, "action", "recovery");
  if (!action.ok) return action;
  const reason = requiredMetadataString(raw, "reason", "recovery");
  if (!reason.ok) return reason;
  const timestamp = requiredMetadataString(raw, "timestamp", "recovery");
  if (!timestamp.ok) return timestamp;
  if (!validTimestamp(timestamp.value)) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "recovery.timestamp must be a valid timestamp.",
      recovery(
        "fix-registry-shape-before-retry",
        "recovery.timestamp was not a valid timestamp.",
      ),
    );
  }
  const backupPath = optionalMetadataString(raw, "backupPath", "recovery");
  if (!backupPath.ok) return backupPath;

  return success(
    compactRecord({
      action: action.value,
      reason: reason.value,
      timestamp: timestamp.value,
      backupPath: backupPath.value,
    }),
    false,
  );
}

function normalizeGitEvidence(
  value: unknown,
): RegistryOperationResult<GitEvidence | undefined> {
  const raw = asRecord(value);
  if (!raw) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "Project registry field gitEvidence must be an object when provided.",
      recovery(
        "fix-registry-shape-before-retry",
        "gitEvidence was not an object.",
      ),
    );
  }
  const unknown = assertKnownFields(raw, GIT_EVIDENCE_FIELDS, "gitEvidence");
  if (unknown) return unknown;

  const remoteUrlFingerprint = optionalMetadataString(
    raw,
    "remoteUrlFingerprint",
    "gitEvidence",
  );
  if (!remoteUrlFingerprint.ok) return remoteUrlFingerprint;
  const branch = optionalMetadataString(raw, "branch", "gitEvidence");
  if (!branch.ok) return branch;
  const worktreePath = optionalMetadataString(
    raw,
    "worktreePath",
    "gitEvidence",
  );
  if (!worktreePath.ok) return worktreePath;
  const commit = optionalMetadataString(raw, "commit", "gitEvidence");
  if (!commit.ok) return commit;
  if (
    remoteUrlFingerprint.value !== undefined &&
    !/^[a-f0-9]{64}$/i.test(remoteUrlFingerprint.value)
  ) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "gitEvidence.remoteUrlFingerprint must be a SHA-256 hex fingerprint, not a raw remote URL.",
      recovery(
        "replace-raw-remote-with-fingerprint-before-retry",
        "Registry git evidence must not persist raw remote URLs or credentials.",
      ),
    );
  }
  if (commit.value !== undefined && !/^[a-f0-9]{7,40}$/i.test(commit.value)) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "gitEvidence.commit must be a 7-40 character hex commit id when provided.",
      recovery(
        "provide-valid-commit-evidence-before-retry",
        "Commit evidence must be bounded local git metadata, not arbitrary text.",
      ),
    );
  }

  const out: GitEvidence = compactRecord({
    remoteUrlFingerprint: remoteUrlFingerprint.value,
    branch: branch.value,
    worktreePath: worktreePath.value,
    commit: commit.value,
  });
  return success(Object.keys(out).length > 0 ? out : undefined, false);
}

function normalizeTargetRepos(
  value: unknown,
): RegistryOperationResult<TargetRepoPointer[] | undefined> {
  if (!Array.isArray(value)) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "Project registry field targetRepos must be an array when provided.",
      recovery(
        "fix-registry-shape-before-retry",
        "targetRepos was not an array.",
      ),
    );
  }

  const repos: TargetRepoPointer[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = asRecord(value[index]);
    if (!raw) {
      return failure(
        "REGISTRY_INVALID_SHAPE",
        `Project registry targetRepos[${index}] must be an object.`,
        recovery(
          "fix-registry-shape-before-retry",
          `targetRepos[${index}] was not an object.`,
        ),
      );
    }
    const unknown = assertKnownFields(
      raw,
      TARGET_REPO_FIELDS,
      `targetRepos[${index}]`,
    );
    if (unknown) return unknown;
    const role = requiredMetadataString(raw, "role", `targetRepos[${index}]`);
    if (!role.ok) return role;
    const repoPath = requiredMetadataString(
      raw,
      "path",
      `targetRepos[${index}]`,
    );
    if (!repoPath.ok) return repoPath;
    repos.push({ role: role.value, path: repoPath.value });
  }
  return success(repos.length > 0 ? repos : undefined, false);
}

function compactRecord<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}

function normalizeProjectRecord(
  value: unknown,
  options: { existingId?: string; persisted?: boolean } = {},
): RegistryOperationResult<ProjectRegistryRecord> {
  const forbidden = rejectCanonicalFields(value);
  if (forbidden) return forbidden;

  const raw = asRecord(value);
  if (!raw) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "Project registry record must be a JSON object.",
      recovery(
        "fix-registry-shape-before-retry",
        "Project record was not an object.",
      ),
    );
  }
  const unknown = assertKnownFields(
    raw,
    PROJECT_RECORD_FIELDS,
    "Project registry record",
  );
  if (unknown) return unknown;

  const rawProjectId = optionalString(raw.projectId);
  const projectId =
    options.existingId ??
    rawProjectId ??
    (options.persisted ? undefined : randomUUID());
  const displayName = requiredNonEmptyString(raw, "displayName");
  const artifactRoot = requiredNonEmptyString(raw, "artifactRoot");
  const runtimeStatePath = requiredNonEmptyString(raw, "runtimeStatePath");
  const rawLastSeenAt = optionalString(raw.lastSeenAt);
  const lastSeenAt =
    rawLastSeenAt ?? (options.persisted ? undefined : nowIso());

  if (
    !projectId ||
    projectId.trim().length === 0 ||
    (hasOwn(raw, "projectId") &&
      (typeof raw.projectId !== "string" || raw.projectId.trim().length === 0))
  ) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "Project registry record requires a non-empty projectId when persisted or explicitly provided.",
      recovery(
        "fix-registry-shape-before-retry",
        "projectId was missing or empty on an existing registry record.",
      ),
    );
  }

  if (
    !lastSeenAt ||
    !validTimestamp(lastSeenAt) ||
    (hasOwn(raw, "lastSeenAt") &&
      (typeof raw.lastSeenAt !== "string" || !validTimestamp(raw.lastSeenAt)))
  ) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "Project registry record requires a valid lastSeenAt timestamp when persisted or explicitly provided.",
      recovery(
        "fix-registry-shape-before-retry",
        "lastSeenAt was missing or invalid on an existing registry record.",
      ),
    );
  }

  if (!displayName || !artifactRoot || !runtimeStatePath) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "Project registry record requires displayName, artifactRoot, and runtimeStatePath.",
      recovery(
        "provide-required-metadata-pointers-before-retry",
        "Required metadata pointer fields were missing.",
      ),
    );
  }

  const historicalAliases = stringArray(raw, "historicalAliases");
  if (!historicalAliases.ok) return historicalAliases;
  const knownRoots = stringArray(raw, "knownRoots");
  if (!knownRoots.ok) return knownRoots;
  const pathAliases = stringArray(raw, "pathAliases");
  if (!pathAliases.ok) return pathAliases;
  const gitEvidence = hasOwn(raw, "gitEvidence")
    ? normalizeGitEvidence(raw.gitEvidence)
    : success(undefined, false);
  if (!gitEvidence.ok) return gitEvidence;
  const targetRepos = hasOwn(raw, "targetRepos")
    ? normalizeTargetRepos(raw.targetRepos)
    : success(undefined, false);
  if (!targetRepos.ok) return targetRepos;

  const activeVersion = optionalMetadataString(
    raw,
    "activeVersion",
    "Project registry record",
  );
  if (!activeVersion.ok) return activeVersion;
  const phase = optionalMetadataString(raw, "phase", "Project registry record");
  if (!phase.ok) return phase;
  const status = optionalMetadataString(raw, "status", "Project registry record");
  if (!status.ok) return status;
  const currentWorkflow = optionalNullableMetadataString(
    raw,
    "currentWorkflow",
    "Project registry record",
  );
  if (!currentWorkflow.ok) return currentWorkflow;
  const currentStory = optionalNullableMetadataString(
    raw,
    "currentStory",
    "Project registry record",
  );
  if (!currentStory.ok) return currentStory;
  const readinessState = optionalMetadataString(
    raw,
    "readinessState",
    "Project registry record",
  );
  if (!readinessState.ok) return readinessState;
  const lastWorkflow = optionalMetadataString(
    raw,
    "lastWorkflow",
    "Project registry record",
  );
  if (!lastWorkflow.ok) return lastWorkflow;

  const record: ProjectRegistryRecord = compactRecord({
    projectId,
    displayName,
    historicalAliases: historicalAliases.value,
    knownRoots: knownRoots.value,
    artifactRoot,
    runtimeStatePath,
    pathAliases: pathAliases.value,
    activeVersion: activeVersion.value,
    phase: phase.value,
    status: status.value,
    currentWorkflow: currentWorkflow.value,
    currentStory: currentStory.value,
    readinessState: readinessState.value,
    lastWorkflow: lastWorkflow.value,
    lastSeenAt,
    gitEvidence: gitEvidence.value,
    targetRepos: targetRepos.value,
  });

  return success(record, false);
}

function validateRegistry(
  value: unknown,
): RegistryOperationResult<BmadProjectRegistry> {
  const forbidden = rejectCanonicalFields(value);
  if (forbidden) return forbidden;

  const raw = asRecord(value);
  if (!raw) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "Registry root must be a JSON object.",
      recovery(
        "fix-registry-shape-before-retry",
        "Registry root was not an object.",
      ),
    );
  }
  const unknown = assertKnownFields(raw, REGISTRY_ROOT_FIELDS, "Registry root");
  if (unknown) return unknown;

  if (!hasOwn(raw, "schemaVersion")) {
    return failure(
      "REGISTRY_SCHEMA_MISSING",
      "Registry schemaVersion is required.",
      recovery(
        "preserve-original-and-recreate-with-supported-schema",
        "schemaVersion is missing.",
      ),
    );
  }
  if (raw.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    return failure(
      "REGISTRY_SCHEMA_UNSUPPORTED",
      `Unsupported registry schemaVersion '${String(raw.schemaVersion)}'.`,
      recovery(
        "preserve-original-and-run-supported-migration",
        `Supported schemaVersion is ${REGISTRY_SCHEMA_VERSION}.`,
      ),
    );
  }
  if (!Array.isArray(raw.projects)) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "Registry projects must be an array.",
      recovery(
        "fix-registry-projects-array-before-retry",
        "projects was missing or not an array.",
      ),
    );
  }

  const projects: ProjectRegistryRecord[] = [];
  const projectIds = new Set<string>();
  for (const project of raw.projects) {
    const normalized = normalizeProjectRecord(project, { persisted: true });
    if (!normalized.ok) return normalized;
    if (projectIds.has(normalized.value.projectId)) {
      return failure(
        "REGISTRY_INVALID_SHAPE",
        `Registry contains duplicate projectId '${normalized.value.projectId}'.`,
        recovery(
          "fix-registry-shape-before-retry",
          "Duplicate projectId entries make stable identity ambiguous.",
        ),
      );
    }
    const ambiguousEquivalent = projects.find(
      (existing) =>
        existing.projectId !== normalized.value.projectId &&
        sameProject(existing, normalized.value),
    );
    if (ambiguousEquivalent) {
      return failure(
        "REGISTRY_INVALID_SHAPE",
        `Registry contains path-equivalent records with different projectId values '${ambiguousEquivalent.projectId}' and '${normalized.value.projectId}'.`,
        recovery(
          "fix-registry-shape-before-retry",
          "Path-equivalent project records with different IDs make project resolution ambiguous.",
        ),
      );
    }
    const nameCollision = findAnyNameCollision(
      { schemaVersion: REGISTRY_SCHEMA_VERSION, projects },
      [normalized.value.displayName, ...normalized.value.historicalAliases],
      normalized.value.projectId,
    );
    if (nameCollision) {
      return failure(
        "REGISTRY_NAME_COLLISION",
        `Registry contains colliding ${nameCollision.field} '${nameCollision.name}' between projects '${nameCollision.project.projectId}' and '${normalized.value.projectId}'.`,
        recovery(
          "choose-unique-display-name-and-retry",
          "Duplicate display names or historical aliases make name-first resolution ambiguous.",
        ),
      );
    }
    projectIds.add(normalized.value.projectId);
    projects.push(normalized.value);
  }

  const updatedAt = optionalTimestampString(raw, "updatedAt", "Registry");
  if (!updatedAt.ok) return updatedAt;
  const recoveryAction = hasOwn(raw, "recovery")
    ? normalizeRecoveryAction(raw.recovery)
    : success(undefined, false);
  if (!recoveryAction.ok) return recoveryAction;

  const registry: BmadProjectRegistry = compactRecord({
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    projects,
    updatedAt: updatedAt.value,
    recovery: recoveryAction.value,
  });
  return success(registry, false);
}

async function readRegistryFile(
  registryPath: string,
): Promise<RegistryOperationResult<BmadProjectRegistry>> {
  if (!fsSync.existsSync(registryPath)) {
    return failure(
      "REGISTRY_NOT_FOUND",
      `Registry file not found: ${registryPath}`,
      recovery(
        "create-registry-with-load-or-create",
        "Registry file does not exist.",
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch (error) {
    return failure(
      "REGISTRY_JSON_INVALID",
      `Registry JSON is invalid: ${registryPath}`,
      recovery(
        "inspect-or-restore-registry-from-backup",
        "JSON parse failed.",
        `${registryPath}.backup`,
      ),
      { cause: error },
    );
  }
  return validateRegistry(parsed);
}

function slashNormalize(value: string): string {
  const slashed = value
    .trim()
    .split(String.fromCharCode(92))
    .join("/");
  const preserveUncPrefix = slashed.startsWith("//");
  const collapsed = slashed.replace(/\/+/g, "/");
  return preserveUncPrefix && collapsed.startsWith("/")
    ? `/${collapsed}`
    : collapsed;
}

function hasExplicitWindowsDrive(value: string): boolean {
  return /^[a-zA-Z]:\//.test(slashNormalize(value));
}

function explicitWindowsDriveLetter(value: string): string | undefined {
  return slashNormalize(value).match(/^([a-zA-Z]):\//)?.[1]?.toLowerCase();
}

function hasMsysDrive(value: string): boolean {
  const normalized = slashNormalize(value);
  return (
    /^\/mnt\/[a-zA-Z]\//i.test(normalized) ||
    /^\/[a-zA-Z]\//.test(normalized) ||
    /^[a-zA-Z]\//.test(normalized)
  );
}

function shouldConvertDrivePrefix(
  driveLetter: string,
  options: { driveStyle: boolean; explicitDriveLetters: Set<string> },
  absoluteMsysPath: boolean,
): boolean {
  if (!options.driveStyle) return false;
  const normalizedDriveLetter = driveLetter.toLowerCase();
  if (
    absoluteMsysPath &&
    (normalizedDriveLetter === "a" || normalizedDriveLetter === "b")
  ) {
    return false;
  }
  return (
    options.explicitDriveLetters.size === 0 ||
    options.explicitDriveLetters.has(normalizedDriveLetter) ||
    process.platform === "win32" ||
    !!process.env.MSYSTEM
  );
}

function comparablePath(
  value: string,
  options: {
    driveStyle: boolean;
    caseInsensitive: boolean;
    explicitDriveLetters: Set<string>;
  },
): string {
  let normalized = slashNormalize(value);
  const wslMntDrive = normalized.match(/^\/mnt\/([a-zA-Z])\/(.+)$/i);
  const absoluteMsysDrive = normalized.match(/^\/([a-zA-Z])\/(.+)$/);
  if (
    wslMntDrive &&
    shouldConvertDrivePrefix(wslMntDrive[1]!, options, true)
  ) {
    normalized = `${wslMntDrive[1]}:/${wslMntDrive[2]}`;
  } else if (
    absoluteMsysDrive &&
    shouldConvertDrivePrefix(absoluteMsysDrive[1]!, options, true)
  ) {
    normalized = `${absoluteMsysDrive[1]}:/${absoluteMsysDrive[2]}`;
  } else {
    const relativeMsysDrive = normalized.match(/^([a-zA-Z])\/(.+)$/);
    if (
      relativeMsysDrive &&
      shouldConvertDrivePrefix(relativeMsysDrive[1]!, options, false)
    )
      normalized = `${relativeMsysDrive[1]}:/${relativeMsysDrive[2]}`;
  }
  const preserveUncPrefix = normalized.startsWith("//");
  normalized = path.posix.normalize(normalized);
  if (preserveUncPrefix && normalized.startsWith("/") && !normalized.startsWith("//"))
    normalized = `/${normalized}`;
  if (normalized.length > 1 && normalized.endsWith("/"))
    normalized = normalized.slice(0, -1);
  return options.caseInsensitive ? normalized.toLowerCase() : normalized;
}

function equivalentProjectPath(a: string, b: string): boolean {
  const explicitDriveLetters = new Set(
    [explicitWindowsDriveLetter(a), explicitWindowsDriveLetter(b)].filter(
      (letter): letter is string => letter !== undefined,
    ),
  );
  const explicitDriveContext =
    hasExplicitWindowsDrive(a) || hasExplicitWindowsDrive(b);
  const runtimeDriveContext = process.platform === "win32" || !!process.env.MSYSTEM;
  const driveStyle =
    (hasMsysDrive(a) || hasMsysDrive(b)) &&
    (explicitDriveContext || runtimeDriveContext);
  const caseInsensitive = explicitDriveContext || driveStyle;
  return (
    comparablePath(a, { driveStyle, caseInsensitive, explicitDriveLetters }) ===
    comparablePath(b, { driveStyle, caseInsensitive, explicitDriveLetters })
  );
}

function isPathLike(value: string): boolean {
  const trimmed = value.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !/^[a-zA-Z]:[\\/]/.test(trimmed))
    return false;
  return (
    path.isAbsolute(trimmed) ||
    /^[a-zA-Z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("//") ||
    trimmed.startsWith(String.fromCharCode(92).repeat(2))
  );
}

function projectPathValues(record: ProjectRegistryRecord): string[] {
  return [
    record.artifactRoot,
    record.runtimeStatePath,
    ...record.knownRoots,
    ...record.pathAliases.filter(isPathLike),
  ].filter((value) => value.trim().length > 0);
}

function cleanPathAlias(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pathAliasShapeFailure(): RegistryOperationFailure {
  return failure(
    "REGISTRY_INVALID_SHAPE",
    "Path alias must be a non-empty path-like string.",
    recovery(
      "provide-path-like-alias-before-retry",
      "Path aliases are filesystem pointers, not display-name aliases.",
    ),
  );
}

function findPathAliasConflict(
  registry: BmadProjectRegistry,
  projectId: string,
  pathAlias: string,
): ProjectRegistryRecord | undefined {
  return registry.projects.find(
    (project) =>
      project.projectId !== projectId &&
      projectPathValues(project).some((value) =>
        equivalentProjectPath(value, pathAlias),
      ),
  );
}

function hasEquivalentPathAlias(values: string[], pathAlias: string): boolean {
  return values.some((value) => equivalentProjectPath(value, pathAlias));
}

function appendEquivalentPath(values: string[], pathAlias: string): string[] {
  return hasEquivalentPathAlias(values, pathAlias) ? values : [...values, pathAlias];
}

function sameProject(
  a: ProjectRegistryRecord,
  b: ProjectRegistryRecord,
): boolean {
  if (a.projectId === b.projectId) return true;
  for (const aPath of projectPathValues(a)) {
    for (const bPath of projectPathValues(b)) {
      if (equivalentProjectPath(aPath, bPath)) return true;
    }
  }
  return false;
}

function unionStrings(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...existing, ...incoming]) {
    const key = item.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizeDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function cleanDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function findDisplayNameCollision(
  registry: BmadProjectRegistry,
  displayName: string,
  projectId: string,
): { project: ProjectRegistryRecord; field: "displayName" | "historical alias" } | undefined {
  const normalized = normalizeDisplayName(displayName);
  for (const project of registry.projects) {
    if (project.projectId === projectId) continue;
    if (normalizeDisplayName(project.displayName) === normalized)
      return { project, field: "displayName" };
    if (
      project.historicalAliases.some(
        (alias) => normalizeDisplayName(alias) === normalized,
      )
    ) {
      return { project, field: "historical alias" };
    }
  }
  return undefined;
}

function findAnyNameCollision(
  registry: BmadProjectRegistry,
  names: string[],
  projectId: string,
): { project: ProjectRegistryRecord; field: "displayName" | "historical alias"; name: string } | undefined {
  for (const name of names) {
    const collision = findDisplayNameCollision(registry, name, projectId);
    if (collision) return { ...collision, name };
  }
  return undefined;
}

function displayNameCollisionFailure(
  displayName: string,
  collision: { project: ProjectRegistryRecord; field: "displayName" | "historical alias" },
): RegistryOperationFailure {
  return failure(
    "REGISTRY_NAME_COLLISION",
    `Display name '${displayName}' collides with ${collision.field} on project '${collision.project.projectId}'.`,
    recovery(
      "choose-unique-display-name-and-retry",
      "Project display names and historical aliases must remain unambiguous for future name-first resolution.",
    ),
  );
}

function appendHistoricalDisplayAlias(
  aliases: string[],
  previousDisplayName: string,
  nextDisplayName: string,
): { aliases: string[]; added?: string } {
  const previous = cleanDisplayName(previousDisplayName);
  const nextNormalized = normalizeDisplayName(nextDisplayName);
  const filtered = aliases.filter(
    (alias) => normalizeDisplayName(alias) !== nextNormalized,
  );
  if (normalizeDisplayName(previous) === nextNormalized)
    return { aliases: filtered };
  if (filtered.some((alias) => normalizeDisplayName(alias) === normalizeDisplayName(previous)))
    return { aliases: filtered };
  return { aliases: [...filtered, previous], added: previous };
}

function unionTargetRepos(
  existing: TargetRepoPointer[] | undefined,
  incoming: TargetRepoPointer[] | undefined,
): TargetRepoPointer[] | undefined {
  const out: TargetRepoPointer[] = [];
  for (const repo of [...(existing ?? []), ...(incoming ?? [])]) {
    const alreadyIncluded = out.some(
      (existingRepo) =>
        existingRepo.role.trim().toLowerCase() ===
          repo.role.trim().toLowerCase() &&
        equivalentProjectPath(existingRepo.path, repo.path),
    );
    if (alreadyIncluded) continue;
    out.push(repo);
  }
  return out.length > 0 ? out : undefined;
}

function mergeProjectRecord(
  existing: ProjectRegistryRecord,
  incoming: ProjectRegistryRecord,
): ProjectRegistryRecord {
  return compactRecord({
    ...existing,
    ...incoming,
    projectId: existing.projectId,
    historicalAliases: unionStrings(
      existing.historicalAliases,
      incoming.historicalAliases,
    ),
    knownRoots: unionStrings(existing.knownRoots, incoming.knownRoots),
    pathAliases: unionStrings(existing.pathAliases, incoming.pathAliases),
    gitEvidence: incoming.gitEvidence ?? existing.gitEvidence,
    targetRepos: unionTargetRepos(existing.targetRepos, incoming.targetRepos),
  });
}

async function writeRecoverableRegistry(
  registryPath: string,
  registry: BmadProjectRegistry,
  hooks: RegistryMutationHooks | undefined,
  options: {
    allowLegacyExisting?: boolean;
    expectedExistingText?: string;
  } = {},
): Promise<RegistryOperationResult<BmadProjectRegistry>> {
  const forbidden = rejectCanonicalFields(registry);
  if (forbidden) return forbidden;

  const dir = path.dirname(registryPath);
  const backupPath = `${registryPath}.backup`;
  const tempPath = path.join(
    dir,
    `.${path.basename(registryPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const text = `${JSON.stringify(registry, null, 2)}\n`;
  let writeOccurred = false;

  try {
    await fs.mkdir(dir, { recursive: true });

    if (fsSync.existsSync(registryPath)) {
      if (options.allowLegacyExisting && options.expectedExistingText !== undefined) {
        const currentText = await fs.readFile(registryPath, "utf8");
        if (currentText !== options.expectedExistingText) {
          return failure(
            "REGISTRY_WRITE_FAILED",
            `Registry changed during schema migration; previous registry was preserved: ${registryPath}`,
            recovery(
              "retry-migration-after-refreshing-registry",
              "The registry changed before migration could safely replace it.",
              backupPath,
            ),
            { writeOccurred: false },
          );
        }
      } else {
        const current = await readRegistryFile(registryPath);
        if (!current.ok) return current;
      }
      await fs.copyFile(registryPath, backupPath);
      writeOccurred = true;
    }

    await fs.writeFile(tempPath, text, "utf8");
    writeOccurred = true;
    await hooks?.afterTempWrite?.({ tempPath, registryPath, backupPath });
    await hooks?.beforeReplace?.({ tempPath, registryPath, backupPath });

    if (fsSync.existsSync(registryPath)) {
      if (options.allowLegacyExisting && options.expectedExistingText !== undefined) {
        const currentText = await fs.readFile(registryPath, "utf8");
        if (currentText !== options.expectedExistingText) {
          await fs.rm(tempPath, { force: true }).catch(() => undefined);
          return failure(
            "REGISTRY_WRITE_FAILED",
            `Registry changed during schema migration; previous registry was preserved: ${registryPath}`,
            recovery(
              "retry-migration-after-refreshing-registry",
              "The registry changed before migration could safely replace it.",
              fsSync.existsSync(backupPath) ? backupPath : undefined,
            ),
            { writeOccurred },
          );
        }
      } else {
        const current = await readRegistryFile(registryPath);
        if (!current.ok) {
          await fs.rm(tempPath, { force: true }).catch(() => undefined);
          return preserveFailure(current.error, writeOccurred);
        }
      }
    }

    await fs.rename(tempPath, registryPath);
    return success(registry, true);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    return failure(
      "REGISTRY_WRITE_FAILED",
      `Registry write failed; previous registry was preserved when present: ${registryPath}`,
      recovery(
        "retry-idempotent-update-after-preserving-last-valid-registry",
        "Temp-write/replace sequence failed before a valid registry could be committed.",
        fsSync.existsSync(backupPath) ? backupPath : undefined,
      ),
      { writeOccurred, cause: error },
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withFileLock<T>(
  lockPath: string,
  task: () => Promise<RegistryOperationResult<T>>,
): Promise<RegistryOperationResult<T>> {
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
  } catch (error) {
    return failure(
      "REGISTRY_LOCK_UNAVAILABLE",
      `Registry lock directory unavailable: ${path.dirname(lockPath)}`,
      recovery(
        "fix-registry-lock-path-and-retry",
        `The registry lock directory ${path.dirname(lockPath)} could not be created.`,
      ),
      { writeOccurred: false, cause: error },
    );
  }
  const startedAt = Date.now();
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let lockToken: string | undefined;

  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx");
      lockToken = `${process.pid} ${nowIso()} ${randomUUID()}\n`;
      await handle.writeFile(lockToken, "utf8");
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        lockToken = undefined;
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
      if (
        code === "EEXIST" &&
        Date.now() - startedAt <= REGISTRY_LOCK_WAIT_TIMEOUT_MS
      ) {
        await sleep(20);
        continue;
      }
      return failure(
        "REGISTRY_LOCK_UNAVAILABLE",
        `Registry lock unavailable: ${lockPath}`,
        recovery(
          "remove-stale-registry-lock-and-retry",
          `The registry lock ${lockPath} could not be acquired before timeout.`,
        ),
        { writeOccurred: false, cause: error },
      );
    }
  }

  try {
    return await task();
  } finally {
    await handle.close().catch(() => undefined);
    const currentToken = await fs
      .readFile(lockPath, "utf8")
      .catch(() => undefined);
    if (lockToken !== undefined && currentToken === lockToken)
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

function mutationQueueKey(registryPath: string): string {
  const resolved = path
    .resolve(registryPath)
    .split(String.fromCharCode(92))
    .join("/");
  return process.platform === "win32" ||
    /^[a-zA-Z]:/.test(resolved) ||
    registryPath.includes(String.fromCharCode(92))
    ? resolved.toLowerCase()
    : resolved;
}

function enqueueMutation<T>(
  registryPath: string,
  task: () => Promise<RegistryOperationResult<T>>,
): Promise<RegistryOperationResult<T>> {
  const key = mutationQueueKey(registryPath);
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => withFileLock(registryPath + ".lock", task));
  const cleanup = next
    .finally(() => {
      if (mutationQueues.get(key) === cleanup) mutationQueues.delete(key);
    })
    .catch(() => undefined);
  mutationQueues.set(key, cleanup);
  return next;
}

export async function loadRegistry(
  options: RegistryOptions = {},
): Promise<RegistryOperationResult<BmadProjectRegistry>> {
  const registryPath = resolveRegistryPathResult(options);
  if (!registryPath.ok) return registryPath;
  return readRegistryFile(registryPath.value);
}

export async function loadOrCreateRegistry(
  options: RegistryOptions = {},
): Promise<RegistryOperationResult<BmadProjectRegistry>> {
  const registryPath = resolveRegistryPathResult(options);
  if (!registryPath.ok) return registryPath;
  return enqueueMutation(registryPath.value, async () => {
    const existing = await readRegistryFile(registryPath.value);
    if (existing.ok) return success(existing.value, false);
    if (existing.error.code !== "REGISTRY_NOT_FOUND") return existing;
    return writeRecoverableRegistry(
      registryPath.value,
      emptyRegistry(),
      options.hooks,
    );
  });
}

export async function migrateRegistrySchemaFromLegacy(
  options: RegistryOptions = {},
): Promise<RegistrySchemaMigrationResult> {
  const registryPath = resolveRegistryPathResult(options);
  if (!registryPath.ok) return registryPath;
  return enqueueMutation<{
    registry: BmadProjectRegistry;
    migration: RegistrySchemaMigrationSummary;
  }>(registryPath.value, async () => {
    if (!fsSync.existsSync(registryPath.value)) {
      const created = await writeRecoverableRegistry(
        registryPath.value,
        emptyRegistry(),
        options.hooks,
      );
      if (!created.ok) return created;
      return success(
        {
          registry: created.value,
          migration: {
            registryPath: registryPath.value,
            from: "absent",
            toSchemaVersion: REGISTRY_SCHEMA_VERSION,
          },
        },
        created.writeOccurred,
        created.recoveryAction,
      );
    }

    const existing = await readRegistryFile(registryPath.value);
    if (existing.ok) {
      return success(
        {
          registry: existing.value,
          migration: {
            registryPath: registryPath.value,
            from: "current",
            toSchemaVersion: REGISTRY_SCHEMA_VERSION,
          },
        },
        false,
      );
    }
    if (existing.error.code !== "REGISTRY_SCHEMA_MISSING") return existing;

    let originalText: string;
    let parsed: unknown;
    try {
      originalText = await fs.readFile(registryPath.value, "utf8");
      parsed = JSON.parse(originalText);
    } catch (error) {
      return failure(
        "REGISTRY_JSON_INVALID",
        `Registry JSON is invalid: ${registryPath.value}`,
        recovery(
          "inspect-or-restore-registry-from-backup",
          "JSON parse failed during legacy schema migration.",
          `${registryPath.value}.backup`,
        ),
        { cause: error },
      );
    }

    const raw = asRecord(parsed);
    if (!raw) {
      return failure(
        "REGISTRY_INVALID_SHAPE",
        "Legacy registry root must be a JSON object before schemaVersion can be applied.",
        recovery(
          "fix-registry-shape-before-retry",
          "Registry root was not an object.",
        ),
      );
    }

    const migrated = validateRegistry({
      ...raw,
      schemaVersion: REGISTRY_SCHEMA_VERSION,
    });
    if (!migrated.ok) return migrated;

    const written = await writeRecoverableRegistry(
      registryPath.value,
      migrated.value,
      options.hooks,
      {
        allowLegacyExisting: true,
        expectedExistingText: originalText,
      },
    );
    if (!written.ok) return written;

    const backupPath = `${registryPath.value}.backup`;
    return success(
      {
        registry: written.value,
        migration: {
          registryPath: registryPath.value,
          from: "missing-schema",
          toSchemaVersion: REGISTRY_SCHEMA_VERSION,
          backupPath: fsSync.existsSync(backupPath) ? backupPath : undefined,
        },
      },
      written.writeOccurred,
      written.recoveryAction,
    );
  });
}

export async function checkProjectDisplayNameAvailable(
  input: ProjectRenameInput,
  options: RegistryOptions = {},
): Promise<ProjectDisplayNameAvailabilityResult> {
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const displayName = typeof input.displayName === "string" ? cleanDisplayName(input.displayName) : "";
  if (!projectId) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "Display-name availability check requires a non-empty projectId.",
      recovery(
        "provide-project-id-before-retry",
        "The availability target projectId was missing or empty.",
      ),
    );
  }
  if (!displayName) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "Display-name availability check requires a non-empty displayName.",
      recovery(
        "provide-non-empty-display-name-before-retry",
        "The requested display name was missing or empty.",
      ),
    );
  }

  const existing = await loadRegistry(options);
  if (!existing.ok) {
    if (existing.error.code === "REGISTRY_NOT_FOUND")
      return success({ projectId, displayName }, false);
    return existing;
  }
  const collision = findDisplayNameCollision(existing.value, displayName, projectId);
  if (collision) return displayNameCollisionFailure(displayName, collision);
  return success({ projectId, displayName }, false);
}

export async function upsertProjectRecord(
  input: ProjectRegistryInput,
  options: RegistryOptions = {},
): Promise<RegistryOperationResult<BmadProjectRegistry>> {
  const inputCheck = normalizeProjectRecord(input);
  if (!inputCheck.ok) return inputCheck;

  const registryPath = resolveRegistryPathResult(options);
  if (!registryPath.ok) return registryPath;
  return enqueueMutation(registryPath.value, async () => {
    const existing = await readRegistryFile(registryPath.value);
    const registry = existing.ok
      ? existing.value
      : existing.error.code === "REGISTRY_NOT_FOUND"
        ? emptyRegistry()
        : undefined;
    if (!registry) return existing;

    const existingProject = registry.projects.find((project) =>
      sameProject(project, inputCheck.value),
    );
    const displayNameCollision = findAnyNameCollision(
      registry,
      [inputCheck.value.displayName, ...inputCheck.value.historicalAliases],
      existingProject?.projectId ?? inputCheck.value.projectId,
    );
    if (displayNameCollision)
      return displayNameCollisionFailure(
        displayNameCollision.name,
        displayNameCollision,
      );
    const nextProject = existingProject
      ? mergeProjectRecord(existingProject, inputCheck.value)
      : inputCheck.value;
    const projects = existingProject
      ? registry.projects.map((project) =>
          project.projectId === existingProject.projectId
            ? nextProject
            : project,
        )
      : [...registry.projects, nextProject];

    return writeRecoverableRegistry(
      registryPath.value,
      { schemaVersion: REGISTRY_SCHEMA_VERSION, projects, updatedAt: nowIso() },
      options.hooks,
    );
  });
}

export async function renameProjectDisplayName(
  input: ProjectRenameInput,
  options: RegistryOptions = {},
): Promise<ProjectRenameResult> {
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const displayName = typeof input.displayName === "string" ? cleanDisplayName(input.displayName) : "";
  if (!projectId) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "Project rename requires a non-empty projectId.",
      recovery(
        "provide-project-id-before-retry",
        "The rename target projectId was missing or empty.",
      ),
    );
  }
  if (!displayName) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "Project rename requires a non-empty displayName.",
      recovery(
        "provide-non-empty-display-name-before-retry",
        "The requested display name was missing or empty.",
      ),
    );
  }

  const registryPath = resolveRegistryPathResult(options);
  if (!registryPath.ok) return registryPath;
  return enqueueMutation(registryPath.value, async () => {
    const existing = await readRegistryFile(registryPath.value);
    if (!existing.ok) return existing;
    const project = existing.value.projects.find(
      (candidate) => candidate.projectId === projectId,
    );
    if (!project) {
      return failure(
        "REGISTRY_PROJECT_NOT_FOUND",
        `Project '${projectId}' was not found in the registry for rename.`,
        recovery(
          "register-project-before-rename",
          "A project must exist in the registry before its display name can be renamed.",
        ),
      );
    }

    if (normalizeDisplayName(project.displayName) === normalizeDisplayName(displayName)) {
      return success(
        {
          registry: existing.value,
          rename: {
            projectId,
            previousDisplayName: project.displayName,
            displayName: project.displayName,
          },
        },
        false,
      );
    }

    const displayNameCollision = findDisplayNameCollision(
      existing.value,
      displayName,
      projectId,
    );
    if (displayNameCollision)
      return displayNameCollisionFailure(displayName, displayNameCollision);

    const aliasUpdate = appendHistoricalDisplayAlias(
      project.historicalAliases,
      project.displayName,
      displayName,
    );
    const updatedProject = compactRecord({
      ...project,
      displayName,
      historicalAliases: aliasUpdate.aliases,
      lastSeenAt: nowIso(),
    });
    const nextRegistry: BmadProjectRegistry = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      projects: existing.value.projects.map((candidate) =>
        candidate.projectId === projectId ? updatedProject : candidate,
      ),
      updatedAt: nowIso(),
    };
    const written = await writeRecoverableRegistry(
      registryPath.value,
      nextRegistry,
      options.hooks,
    );
    if (!written.ok) return written;
    return success(
      {
        registry: written.value,
        rename: {
          projectId,
          previousDisplayName: project.displayName,
          displayName,
          addedHistoricalAlias: aliasUpdate.added,
        },
      },
      written.writeOccurred,
      written.recoveryAction,
    );
  });
}

export async function addProjectPathAlias(
  input: ProjectPathAliasInput,
  options: RegistryOptions = {},
): Promise<ProjectPathAliasResult> {
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const pathAlias = cleanPathAlias(input.pathAlias);
  if (!projectId) {
    return failure(
      "REGISTRY_INVALID_SHAPE",
      "Path alias registration requires a non-empty projectId.",
      recovery(
        "provide-project-id-before-retry",
        "The path alias target projectId was missing or empty.",
      ),
    );
  }
  if (!pathAlias || !isPathLike(pathAlias)) return pathAliasShapeFailure();

  const registryPath = resolveRegistryPathResult(options);
  if (!registryPath.ok) return registryPath;
  return enqueueMutation(registryPath.value, async () => {
    const existing = await readRegistryFile(registryPath.value);
    if (!existing.ok) return existing;
    const project = existing.value.projects.find(
      (candidate) => candidate.projectId === projectId,
    );
    const conflict = findPathAliasConflict(existing.value, projectId, pathAlias);
    if (conflict) {
      return failure(
        "REGISTRY_PATH_ALIAS_CONFLICT",
        `Path alias '${pathAlias}' conflicts with registered project '${conflict.projectId}'.`,
        recovery(
          "choose-non-conflicting-path-alias-and-retry",
          "Path aliases must not point at another project's known roots, artifact root, runtime state path, or aliases.",
        ),
      );
    }
    if (!project) {
      return failure(
        "REGISTRY_PROJECT_NOT_FOUND",
        `Project '${projectId}' was not found in the registry for path alias registration.`,
        recovery(
          "register-project-before-alias",
          "A project must exist in the registry before path aliases can be added.",
        ),
      );
    }

    const nextPathAliases = appendEquivalentPath(project.pathAliases, pathAlias);
    const nextKnownRoots = input.knownRoot
      ? appendEquivalentPath(project.knownRoots, pathAlias)
      : project.knownRoots;
    const added =
      nextPathAliases.length !== project.pathAliases.length ||
      nextKnownRoots.length !== project.knownRoots.length;
    if (!added) {
      return success(
        { registry: existing.value, projectId, pathAlias, added: false as boolean },
        false,
      );
    }

    const updatedProject = compactRecord({
      ...project,
      pathAliases: nextPathAliases,
      knownRoots: nextKnownRoots,
      lastSeenAt: nowIso(),
    });
    const nextRegistry: BmadProjectRegistry = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      projects: existing.value.projects.map((candidate) =>
        candidate.projectId === projectId ? updatedProject : candidate,
      ),
      updatedAt: nowIso(),
    };
    const written = await writeRecoverableRegistry(
      registryPath.value,
      nextRegistry,
      options.hooks,
    );
    if (!written.ok) return written;
    return success(
      { registry: written.value, projectId, pathAlias, added: true as boolean },
      written.writeOccurred,
      written.recoveryAction,
    );
  });
}
