import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadPathConfig } from "./paths.js";
import { getBaselineLockFile, getProjectIdentityFile, type ProjectIdentity } from "./project.js";
import {
  REGISTRY_SCHEMA_VERSION,
  loadRegistry,
  migrateRegistrySchemaFromLegacy,
  resolveRegistryPath,
  type RegistryOptions,
  type RegistrySchemaMigrationSummary,
} from "./registry.js";
import { reconcileExistingWorkspace } from "./resolution.js";
import { getStateFile, type RuntimeState } from "./state.js";

export type V011MigrationCompatibility = "v0.1.1-compatible" | "v0.2";

export interface MigrationArtifactSnapshot {
  path: string;
  size: number;
  sha256: string;
}

export interface V011ReconcileMigrationPlan {
  ready: boolean;
  root: string;
  registryPath?: string;
  artifactRoot: string;
  runtimeStatePath: string;
  projectIdentityPath: string;
  baselineLockPath: string;
  projectId?: string;
  displayName?: string;
  compatibility: V011MigrationCompatibility;
  schemaVersionToApply: typeof REGISTRY_SCHEMA_VERSION;
  migrationPath: string[];
  artifactSnapshot: MigrationArtifactSnapshot[];
  blockers: string[];
}

export interface MigrationRecoveryEvidence {
  action: string;
  reason: string;
  error: string;
  writeOccurred: boolean;
  touchedPaths: string[];
}

export interface V011ReconcileMigrationResult {
  ok: boolean;
  writeOccurred: boolean;
  projectId?: string;
  registryPath?: string;
  compatibility: V011MigrationCompatibility;
  schemaMigration?: RegistrySchemaMigrationSummary;
  schemaVersionApplied?: typeof REGISTRY_SCHEMA_VERSION;
  registryProjectCount?: number;
  migrationPath: string[];
  artifactSnapshotBefore: MigrationArtifactSnapshot[];
  artifactSnapshotAfter: MigrationArtifactSnapshot[];
  artifactsPreserved: boolean;
  touchedPaths: string[];
  recoveryEvidence?: MigrationRecoveryEvidence;
  error?: string;
}

interface JsonRead<T> {
  exists: boolean;
  ok: boolean;
  value?: T;
  error?: string;
}

function readJson<T>(file: string): JsonRead<T> {
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
    typeof value.projectId === "string" &&
    value.projectId.trim().length > 0 &&
    typeof value.projectName === "string" &&
    value.projectName.trim().length > 0 &&
    isRecord(value.rootFingerprint) &&
    typeof value.rootFingerprint.initialPath === "string" &&
    typeof value.rootFingerprint.bmadOutputRoot === "string";
}

function isRuntimeState(value: unknown): value is RuntimeState {
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.active === "boolean" &&
    typeof value.mode === "string" &&
    typeof value.phase === "string";
}

function isBaselineLock(value: unknown): boolean {
  return isRecord(value) && value.version === 1;
}

function snapshotArtifacts(root: string, artifactRoot: string): MigrationArtifactSnapshot[] {
  if (!fs.existsSync(artifactRoot)) return [];
  if (!fs.statSync(artifactRoot).isDirectory()) return [];
  const snapshots: MigrationArtifactSnapshot[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const data = fs.readFileSync(full);
      snapshots.push({
        path: path.relative(root, full).replaceAll(path.sep, "/"),
        size: data.byteLength,
        sha256: crypto.createHash("sha256").update(data).digest("hex"),
      });
    }
  };
  walk(artifactRoot);
  return snapshots.sort((left, right) => left.path.localeCompare(right.path));
}

function snapshotsEqual(left: MigrationArtifactSnapshot[], right: MigrationArtifactSnapshot[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function defaultMigrationPath(): string[] {
  return [
    "snapshot-canonical-artifacts-before",
    "apply-current-registry-schemaVersion",
    "reconcile-workspace-metadata-into-registry",
    "snapshot-canonical-artifacts-after",
    "compare-artifact-checksums",
    "record-recovery-and-retry-idempotently-on-failure",
  ];
}

export function buildV011ReconcileMigrationPlan(
  cwd: string,
  options: RegistryOptions = {},
): V011ReconcileMigrationPlan {
  const root = path.resolve(cwd);
  const cfg = loadPathConfig(root);
  const runtimeStatePath = getStateFile(root);
  const projectIdentityPath = getProjectIdentityFile(root);
  const baselineLockPath = getBaselineLockFile(root);
  const state = readJson<RuntimeState>(runtimeStatePath);
  const identity = readJson<ProjectIdentity>(projectIdentityPath);
  const baseline = readJson<Record<string, unknown>>(baselineLockPath);
  const blockers: string[] = [];
  let registryPath: string | undefined;

  try {
    registryPath = resolveRegistryPath(options);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }

  if (!state.exists) blockers.push("missing .bmad-runtime/state.json");
  else if (!state.ok || !isRuntimeState(state.value)) blockers.push("invalid .bmad-runtime/state.json");

  if (!identity.exists) blockers.push("missing .bmad-runtime/project-identity.json");
  else if (!identity.ok || !isProjectIdentity(identity.value)) blockers.push("invalid .bmad-runtime/project-identity.json");

  if (!fs.existsSync(cfg.output_folder)) blockers.push("missing canonical artifact root");
  else if (!fs.statSync(cfg.output_folder).isDirectory()) blockers.push("canonical artifact root is not a directory");

  if (baseline.exists && (!baseline.ok || !isBaselineLock(baseline.value))) {
    blockers.push("invalid .bmad-runtime/baseline-lock.json");
  }

  return {
    ready: blockers.length === 0,
    root,
    registryPath,
    artifactRoot: cfg.output_folder,
    runtimeStatePath,
    projectIdentityPath,
    baselineLockPath,
    projectId: identity.ok && isProjectIdentity(identity.value) ? identity.value.projectId : undefined,
    displayName: identity.ok && isProjectIdentity(identity.value) ? identity.value.projectName : undefined,
    compatibility: baseline.exists ? "v0.2" : "v0.1.1-compatible",
    schemaVersionToApply: REGISTRY_SCHEMA_VERSION,
    migrationPath: defaultMigrationPath(),
    artifactSnapshot: snapshotArtifacts(root, cfg.output_folder),
    blockers,
  };
}

function recoveryEvidence(input: {
  action: string;
  reason: string;
  error: string;
  writeOccurred: boolean;
  touchedPaths: string[];
}): MigrationRecoveryEvidence {
  return {
    action: input.action,
    reason: input.reason,
    error: input.error,
    writeOccurred: input.writeOccurred,
    touchedPaths: input.touchedPaths,
  };
}

export async function migrateV011WorkspaceToV02Registry(
  cwd: string,
  options: RegistryOptions = {},
): Promise<V011ReconcileMigrationResult> {
  const plan = buildV011ReconcileMigrationPlan(cwd, options);
  if (!plan.ready) {
    return {
      ok: false,
      writeOccurred: false,
      registryPath: plan.registryPath,
      compatibility: plan.compatibility,
      migrationPath: plan.migrationPath,
      artifactSnapshotBefore: plan.artifactSnapshot,
      artifactSnapshotAfter: snapshotArtifacts(plan.root, plan.artifactRoot),
      artifactsPreserved: true,
      touchedPaths: [],
      recoveryEvidence: recoveryEvidence({
        action: "repair-workspace-before-migration",
        reason: plan.blockers.join("; "),
        error: "Workspace is not ready for v0.1.1 -> v0.2 registry migration.",
        writeOccurred: false,
        touchedPaths: [],
      }),
      error: plan.blockers.join("; "),
    };
  }

  const schema = await migrateRegistrySchemaFromLegacy(options);
  if (!schema.ok) {
    const after = snapshotArtifacts(plan.root, plan.artifactRoot);
    return {
      ok: false,
      writeOccurred: schema.error.writeOccurred,
      projectId: plan.projectId,
      registryPath: plan.registryPath,
      compatibility: plan.compatibility,
      migrationPath: plan.migrationPath,
      artifactSnapshotBefore: plan.artifactSnapshot,
      artifactSnapshotAfter: after,
      artifactsPreserved: snapshotsEqual(plan.artifactSnapshot, after),
      touchedPaths: schema.error.writeOccurred && plan.registryPath ? [plan.registryPath] : [],
      recoveryEvidence: recoveryEvidence({
        action: schema.error.recoveryAction.action,
        reason: schema.error.recoveryAction.reason,
        error: schema.error.message,
        writeOccurred: schema.error.writeOccurred,
        touchedPaths: schema.error.writeOccurred && plan.registryPath ? [plan.registryPath] : [],
      }),
      error: schema.error.message,
    };
  }

  const reconciled = await reconcileExistingWorkspace(plan.root, options);
  const after = snapshotArtifacts(plan.root, plan.artifactRoot);
  const artifactsPreserved = snapshotsEqual(plan.artifactSnapshot, after);
  const touchedPaths = [
    ...(schema.writeOccurred && plan.registryPath ? [plan.registryPath] : []),
    ...reconciled.touchedPaths,
  ].filter((value, index, values) => values.indexOf(value) === index);

  if (!reconciled.ok) {
    return {
      ok: false,
      writeOccurred: schema.writeOccurred || reconciled.writeOccurred,
      projectId: plan.projectId,
      registryPath: plan.registryPath,
      compatibility: plan.compatibility,
      schemaMigration: schema.value.migration,
      schemaVersionApplied: schema.value.registry.schemaVersion,
      migrationPath: plan.migrationPath,
      artifactSnapshotBefore: plan.artifactSnapshot,
      artifactSnapshotAfter: after,
      artifactsPreserved,
      touchedPaths,
      recoveryEvidence: recoveryEvidence({
        action: reconciled.recoveryAction ?? "retry-migration-after-reconcile-failure",
        reason: "Workspace reconcile did not complete.",
        error: reconciled.error ?? "Unknown reconcile failure.",
        writeOccurred: schema.writeOccurred || reconciled.writeOccurred,
        touchedPaths,
      }),
      error: reconciled.error,
    };
  }

  if (!artifactsPreserved) {
    return {
      ok: false,
      writeOccurred: schema.writeOccurred || reconciled.writeOccurred,
      projectId: reconciled.projectId,
      registryPath: plan.registryPath,
      compatibility: plan.compatibility,
      schemaMigration: schema.value.migration,
      schemaVersionApplied: schema.value.registry.schemaVersion,
      registryProjectCount: reconciled.registryProjectCount,
      migrationPath: plan.migrationPath,
      artifactSnapshotBefore: plan.artifactSnapshot,
      artifactSnapshotAfter: after,
      artifactsPreserved: false,
      touchedPaths,
      recoveryEvidence: recoveryEvidence({
        action: "inspect-artifact-snapshot-drift-before-retry",
        reason: "Canonical artifact snapshot changed during metadata-only migration.",
        error: "Artifact checksum comparison failed.",
        writeOccurred: schema.writeOccurred || reconciled.writeOccurred,
        touchedPaths,
      }),
      error: "Artifact checksum comparison failed.",
    };
  }

  const registry = await loadRegistry(options);
  return {
    ok: true,
    writeOccurred: schema.writeOccurred || reconciled.writeOccurred,
    projectId: reconciled.projectId,
    registryPath: plan.registryPath,
    compatibility: plan.compatibility,
    schemaMigration: schema.value.migration,
    schemaVersionApplied: registry.ok ? registry.value.schemaVersion : schema.value.registry.schemaVersion,
    registryProjectCount: registry.ok ? registry.value.projects.length : reconciled.registryProjectCount,
    migrationPath: plan.migrationPath,
    artifactSnapshotBefore: plan.artifactSnapshot,
    artifactSnapshotAfter: after,
    artifactsPreserved: true,
    touchedPaths,
  };
}

export function formatV011ReconcileMigrationResult(result: V011ReconcileMigrationResult): string {
  const lines = [
    `Migration: ${result.ok ? "ok" : "blocked"}`,
    `Compatibility: ${result.compatibility}`,
    `Registry: ${result.registryPath ?? "unresolved"}`,
    `Schema version: ${result.schemaVersionApplied ?? REGISTRY_SCHEMA_VERSION}`,
    `Artifacts preserved: ${result.artifactsPreserved ? "yes" : "no"}`,
    `Write occurred: ${result.writeOccurred ? "true" : "false"}`,
    `Touched paths: ${result.touchedPaths.length > 0 ? result.touchedPaths.join(", ") : "none"}`,
  ];
  if (result.projectId) lines.push(`Project ID: ${result.projectId}`);
  if (result.registryProjectCount !== undefined) lines.push(`Registry project count: ${result.registryProjectCount}`);
  if (result.schemaMigration) lines.push(`Schema migration: ${result.schemaMigration.from} -> ${result.schemaMigration.toSchemaVersion}`);
  if (result.recoveryEvidence) {
    lines.push(`Recovery: ${result.recoveryEvidence.action}`);
    lines.push(`Cause: ${result.recoveryEvidence.reason}`);
  }
  if (result.error) lines.push(`Error: ${result.error}`);
  return lines.join("\n");
}
