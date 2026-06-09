import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildV011ReconcileMigrationPlan, formatV011ReconcileMigrationResult, migrateV011WorkspaceToV02Registry } from "../extensions/bmad-runtime/migration.js";
import { getStateFile } from "../extensions/bmad-runtime/state.js";
import { REGISTRY_SCHEMA_VERSION, loadRegistry, type ProjectRegistryRecord } from "../extensions/bmad-runtime/registry.js";

let tempDirs: string[] = [];

function makeRoot(prefix = "pi-bmad-migration-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function registryFile(runtimeHome: string): string {
  return path.join(runtimeHome, "projects.json");
}

function record(root: string, overrides: Partial<ProjectRegistryRecord> = {}): ProjectRegistryRecord {
  return {
    projectId: "existing-project",
    displayName: "Existing Project",
    historicalAliases: [],
    knownRoots: [root],
    artifactRoot: path.join(root, "_bmad-output"),
    runtimeStatePath: getStateFile(root),
    pathAliases: [root],
    lastSeenAt: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

function writeRegistry(runtimeHome: string, projects: ProjectRegistryRecord[]): void {
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.writeFileSync(
    registryFile(runtimeHome),
    `${JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, projects, updatedAt: "2026-06-09T00:00:00.000Z" }, null, 2)}\n`,
    "utf8",
  );
}

function writeLegacyWorkspace(root: string): void {
  fs.mkdirSync(path.join(root, ".bmad-runtime"), { recursive: true });
  fs.mkdirSync(path.join(root, "_bmad-output", "planning-artifacts"), { recursive: true });
  fs.mkdirSync(path.join(root, "_bmad-output", "implementation-artifacts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".bmad-runtime", "state.json"),
    `${JSON.stringify({
      version: 1,
      active: false,
      mode: "interview",
      track: "bmad-method",
      phase: "2-planning",
      workflowHistory: [],
      autonomy: { phase3And4Yolo: true, askUserOnlyFor: [] },
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      parkingLot: [],
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, ".bmad-runtime", "project-identity.json"),
    `${JSON.stringify({
      version: 1,
      projectId: "legacy-project",
      projectName: "Legacy Workspace",
      createdAt: "2026-06-09T00:00:00.000Z",
      rootFingerprint: { initialPath: root, bmadOutputRoot: "_bmad-output" },
      clonePolicy: "new-id-by-default",
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(root, "_bmad-output", "planning-artifacts", "prd.md"), "# PRD\n\nLegacy artifact.\n", "utf8");
  fs.writeFileSync(path.join(root, "_bmad-output", "implementation-artifacts", "story.md"), "# Story\n\nLegacy story.\n", "utf8");
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).replaceAll(path.sep, "/"));
    }
  };
  walk(root);
  return out.sort();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("v0.1.1 workspace migration to v0.2 registry", () => {
  it("reconciles a v0.1.1-like workspace into registry metadata without moving artifacts", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    writeLegacyWorkspace(root);
    const filesBefore = listFiles(root);
    const plan = buildV011ReconcileMigrationPlan(root, { runtimeHome });

    const migrated = await migrateV011WorkspaceToV02Registry(root, { runtimeHome });
    const registry = await loadRegistry({ runtimeHome });

    expect(plan.ready).toBe(true);
    expect(plan.compatibility).toBe("v0.1.1-compatible");
    expect(migrated.ok).toBe(true);
    expect(migrated.artifactsPreserved).toBe(true);
    expect(migrated.artifactSnapshotBefore).toEqual(migrated.artifactSnapshotAfter);
    expect(listFiles(root)).toEqual(filesBefore);
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    expect(registry.value.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION);
    expect(registry.value.projects[0]).toMatchObject({
      projectId: "legacy-project",
      displayName: "Legacy Workspace",
      knownRoots: [root],
      artifactRoot: path.join(root, "_bmad-output"),
      runtimeStatePath: getStateFile(root),
      pathAliases: [root],
    });
  });

  it("applies schemaVersion to a legacy registry missing schema", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    writeLegacyWorkspace(root);
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(registryFile(runtimeHome), `${JSON.stringify({ projects: [] }, null, 2)}\n`, "utf8");

    const migrated = await migrateV011WorkspaceToV02Registry(root, { runtimeHome });
    const parsed = JSON.parse(fs.readFileSync(registryFile(runtimeHome), "utf8")) as { schemaVersion?: number };

    expect(migrated.ok).toBe(true);
    expect(migrated.schemaMigration?.from).toBe("missing-schema");
    expect(parsed.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION);
    expect(formatV011ReconcileMigrationResult(migrated)).toContain("Schema migration: missing-schema -> 1");
  });

  it("blocks migration without writing when the artifact root is not a directory", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    fs.mkdirSync(path.join(root, ".bmad-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".bmad-runtime", "state.json"),
      `${JSON.stringify({
        version: 1,
        active: false,
        mode: "interview",
        phase: "2-planning",
        workflowHistory: [],
        autonomy: { phase3And4Yolo: true, askUserOnlyFor: [] },
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
        parkingLot: [],
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, ".bmad-runtime", "project-identity.json"),
      `${JSON.stringify({
        version: 1,
        projectId: "bad-artifacts",
        projectName: "Bad Artifacts",
        createdAt: "2026-06-09T00:00:00.000Z",
        rootFingerprint: { initialPath: root, bmadOutputRoot: "_bmad-output" },
        clonePolicy: "new-id-by-default",
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(root, "_bmad-output"), "not a directory", "utf8");

    const migrated = await migrateV011WorkspaceToV02Registry(root, { runtimeHome });

    expect(migrated.ok).toBe(false);
    expect(migrated.writeOccurred).toBe(false);
    expect(migrated.error).toContain("canonical artifact root is not a directory");
    expect(fs.existsSync(registryFile(runtimeHome))).toBe(false);
  });

  it("preserves the last valid registry after simulated migration failure and retries idempotently", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const existingRoot = makeRoot();
    writeLegacyWorkspace(root);
    writeRegistry(runtimeHome, [record(existingRoot)]);
    const originalRegistry = fs.readFileSync(registryFile(runtimeHome), "utf8");

    const failed = await migrateV011WorkspaceToV02Registry(root, {
      runtimeHome,
      hooks: {
        beforeReplace() {
          throw new Error("simulated migration failure");
        },
      },
    });

    expect(failed.ok).toBe(false);
    expect(failed.artifactsPreserved).toBe(true);
    expect(failed.recoveryEvidence?.action).toBe("retry-idempotent-update-after-preserving-last-valid-registry");
    expect(fs.readFileSync(registryFile(runtimeHome), "utf8")).toBe(originalRegistry);

    const retried = await migrateV011WorkspaceToV02Registry(root, { runtimeHome });
    const registry = await loadRegistry({ runtimeHome });

    expect(retried.ok).toBe(true);
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    expect(registry.value.projects.map((project) => project.projectId).sort()).toEqual([
      "existing-project",
      "legacy-project",
    ]);
  });
});
