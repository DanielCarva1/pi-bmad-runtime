import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORBIDDEN_CANONICAL_REGISTRY_FIELDS,
  REGISTRY_SCHEMA_VERSION,
  addProjectPathAlias,
  loadOrCreateRegistry,
  loadRegistry,
  renameProjectDisplayName,
  resolveRegistryPath,
  upsertProjectRecord,
} from "../extensions/bmad-runtime/registry.js";

let tempDirs: string[] = [];
const home = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-registry-"));
  tempDirs.push(dir);
  return dir;
};
const fileFor = (runtimeHome: string) =>
  path.join(runtimeHome, "projects.json");
const record = (overrides: Record<string, unknown> = {}) => ({
  projectId: "proj-1",
  displayName: "Pi BMAD Builder",
  knownRoots: ["/work/builder"],
  artifactRoot: "/work/builder/_bmad-output/projects/pi-bmad-builder",
  runtimeStatePath: "/work/builder/.bmad-runtime/state.json",
  pathAliases: ["builder"],
  lastSeenAt: "2026-06-08T00:00:00.000Z",
  ...overrides,
});
const otherRecord = (overrides: Record<string, unknown> = {}) =>
  record({
    projectId: "proj-2",
    displayName: "Other Project",
    knownRoots: ["/work/other"],
    artifactRoot: "/work/other/_bmad-output/projects/other",
    runtimeStatePath: "/work/other/.bmad-runtime/state.json",
    pathAliases: ["other"],
    ...overrides,
  });
const writeRegistry = (runtimeHome: string, projects: unknown[]) => {
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.writeFileSync(
    fileFor(runtimeHome),
    `${JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, projects }, null, 2)}\n`,
    "utf8",
  );
};

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("global BMAD project registry", () => {
  it("creates missing registry as metadata-only JSON with schemaVersion and projects", async () => {
    const runtimeHome = home();
    const result = await loadOrCreateRegistry({ runtimeHome });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.writeOccurred).toBe(true);
    expect(result.value).toEqual({
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      projects: [],
    });
    const raw = fs.readFileSync(fileFor(runtimeHome), "utf8");
    expect(JSON.parse(raw)).toEqual({
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      projects: [],
    });
    for (const field of FORBIDDEN_CANONICAL_REGISTRY_FIELDS)
      expect(raw).not.toContain(`\"${field}\"`);
  });

  it("upserts metadata pointers and preserves stable projectId", async () => {
    const runtimeHome = home();
    expect(
      (
        await upsertProjectRecord(
          record({
            gitEvidence: { branch: "main" },
            targetRepos: [{ role: "runtime", path: "/work/runtime" }],
          }),
          { runtimeHome },
        )
      ).ok,
    ).toBe(true);
    const second = await upsertProjectRecord(
      record({
        projectId: "proj-should-not-win",
        displayName: "Renamed",
        pathAliases: ["builder", "pi-builder"],
        lastSeenAt: "2026-06-08T01:00:00.000Z",
      }),
      { runtimeHome },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.projects).toHaveLength(1);
    expect(second.value.projects[0]).toMatchObject({
      projectId: "proj-1",
      displayName: "Renamed",
      pathAliases: ["builder", "pi-builder"],
      lastSeenAt: "2026-06-08T01:00:00.000Z",
    });
  });

  it("preserves stable projectId for equivalent Windows/MSYS-style paths", async () => {
    const runtimeHome = home();
    expect(
      (
        await upsertProjectRecord(
          record({
            projectId: "win-proj",
            knownRoots: [String.raw`C:\Work\Builder`],
            artifactRoot: String.raw`C:\Work\Builder\_bmad-output\projects\pi-bmad-builder`,
            runtimeStatePath: String.raw`C:\Work\Builder\.bmad-runtime\state.json`,
            pathAliases: [String.raw`C:\Work\Builder`],
          }),
          { runtimeHome },
        )
      ).ok,
    ).toBe(true);
    const second = await upsertProjectRecord(
      record({
        projectId: "should-not-replace-win-proj",
        displayName: "Windows Path Equivalent",
        knownRoots: ["c:/work/builder"],
        artifactRoot: "c:/work/builder/_bmad-output/projects/pi-bmad-builder",
        runtimeStatePath: "c:/work/builder/.bmad-runtime/state.json",
        pathAliases: ["c:/work/builder"],
      }),
      { runtimeHome },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.projects).toHaveLength(1);
    expect(second.value.projects[0]?.projectId).toBe("win-proj");
  });

  it("merges project arrays and targetRepos instead of wiping existing metadata", async () => {
    const runtimeHome = home();
    const first = await upsertProjectRecord(
      record({
        historicalAliases: ["old-name"],
        knownRoots: ["/work/builder", "/work/shared"],
        pathAliases: ["builder"],
        gitEvidence: { branch: "main" },
        targetRepos: [{ role: "runtime", path: "/repos/runtime" }],
      }),
      { runtimeHome },
    );
    expect(first.ok).toBe(true);

    const second = await upsertProjectRecord(
      record({
        projectId: "proj-should-not-win",
        displayName: "Renamed",
        historicalAliases: ["new-name"],
        knownRoots: ["/work/builder", "/work/new-root"],
        pathAliases: ["builder", "pi-builder"],
        targetRepos: [
          { role: "runtime", path: "/repos/runtime" },
          { role: "target", path: "/repos/target" },
        ],
      }),
      { runtimeHome },
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.projects).toHaveLength(1);
    expect(second.value.projects[0]).toMatchObject({
      projectId: "proj-1",
      displayName: "Renamed",
      historicalAliases: ["old-name", "new-name"],
      knownRoots: ["/work/builder", "/work/shared", "/work/new-root"],
      pathAliases: ["builder", "pi-builder"],
      gitEvidence: { branch: "main" },
      targetRepos: [
        { role: "runtime", path: "/repos/runtime" },
        { role: "target", path: "/repos/target" },
      ],
    });
  });

  it("renames displayName while preserving projectId and adding the old name as a historical alias", async () => {
    const runtimeHome = home();
    const first = await upsertProjectRecord(record({ historicalAliases: ["Builder v0"] }), { runtimeHome });
    expect(first.ok).toBe(true);

    const renamed = await renameProjectDisplayName(
      { projectId: "proj-1", displayName: "Pi BMAD Runtime" },
      { runtimeHome },
    );

    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.writeOccurred).toBe(true);
    expect(renamed.value.rename).toMatchObject({
      projectId: "proj-1",
      previousDisplayName: "Pi BMAD Builder",
      displayName: "Pi BMAD Runtime",
      addedHistoricalAlias: "Pi BMAD Builder",
    });
    expect(renamed.value.registry.projects).toHaveLength(1);
    expect(renamed.value.registry.projects[0]).toMatchObject({
      projectId: "proj-1",
      displayName: "Pi BMAD Runtime",
      historicalAliases: ["Builder v0", "Pi BMAD Builder"],
    });
  });

  it("treats same-name rename as idempotent without duplicate aliases", async () => {
    const runtimeHome = home();
    await upsertProjectRecord(
      record({ historicalAliases: ["Pi BMAD Builder"] }),
      { runtimeHome },
    );

    const renamed = await renameProjectDisplayName(
      { projectId: "proj-1", displayName: "  Pi BMAD Builder  " },
      { runtimeHome },
    );

    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.writeOccurred).toBe(false);
    expect(renamed.value.registry.projects[0]?.historicalAliases).toEqual([
      "Pi BMAD Builder",
    ]);
  });

  it("blocks displayName collisions without mutating the registry", async () => {
    const runtimeHome = home();
    await upsertProjectRecord(record(), { runtimeHome });
    await upsertProjectRecord(otherRecord(), { runtimeHome });
    const before = fs.readFileSync(fileFor(runtimeHome), "utf8");

    const renamed = await renameProjectDisplayName(
      { projectId: "proj-1", displayName: " other project " },
      { runtimeHome },
    );

    expect(renamed.ok).toBe(false);
    if (renamed.ok) return;
    expect(renamed.error.writeOccurred).toBe(false);
    expect(renamed.error.recoveryAction.action).toBe(
      "choose-unique-display-name-and-retry",
    );
    expect(fs.readFileSync(fileFor(runtimeHome), "utf8")).toBe(before);
  });

  it("blocks rename to another project's historical alias", async () => {
    const runtimeHome = home();
    await upsertProjectRecord(record(), { runtimeHome });
    await upsertProjectRecord(
      otherRecord({ historicalAliases: ["Legacy Builder"] }),
      { runtimeHome },
    );

    const renamed = await renameProjectDisplayName(
      { projectId: "proj-1", displayName: "legacy builder" },
      { runtimeHome },
    );

    expect(renamed.ok).toBe(false);
    if (renamed.ok) return;
    expect(renamed.error.writeOccurred).toBe(false);
    expect(renamed.error.message).toContain("historical alias");
  });

  it("blocks upsert of a distinct project with a colliding visible displayName", async () => {
    const runtimeHome = home();
    await upsertProjectRecord(record(), { runtimeHome });

    const duplicate = await upsertProjectRecord(
      otherRecord({ displayName: " pi bmad builder " }),
      { runtimeHome },
    );

    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.error.writeOccurred).toBe(false);
    expect(duplicate.error.recoveryAction.action).toBe(
      "choose-unique-display-name-and-retry",
    );
  });

  it("blocks upsert of a distinct project with a colliding incoming historical alias", async () => {
    const runtimeHome = home();
    await upsertProjectRecord(record(), { runtimeHome });

    const duplicateAlias = await upsertProjectRecord(
      otherRecord({ historicalAliases: ["PI BMAD BUILDER"] }),
      { runtimeHome },
    );

    expect(duplicateAlias.ok).toBe(false);
    if (duplicateAlias.ok) return;
    expect(duplicateAlias.error.code).toBe("REGISTRY_NAME_COLLISION");
    expect(duplicateAlias.error.writeOccurred).toBe(false);
  });

  it("removes the current displayName from historicalAliases when renaming back", async () => {
    const runtimeHome = home();
    await upsertProjectRecord(record(), { runtimeHome });
    await renameProjectDisplayName(
      { projectId: "proj-1", displayName: "Second Name" },
      { runtimeHome },
    );

    const renamedBack = await renameProjectDisplayName(
      { projectId: "proj-1", displayName: "Pi BMAD Builder" },
      { runtimeHome },
    );

    expect(renamedBack.ok).toBe(true);
    if (!renamedBack.ok) return;
    expect(renamedBack.value.registry.projects[0]).toMatchObject({
      displayName: "Pi BMAD Builder",
      historicalAliases: ["Second Name"],
    });
  });

  it("rejects non-string rename input with structured no-write failure", async () => {
    const runtimeHome = home();
    await upsertProjectRecord(record(), { runtimeHome });

    const result = await renameProjectDisplayName(
      { projectId: 123, displayName: "New" } as never,
      { runtimeHome },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REGISTRY_INVALID_SHAPE");
    expect(result.error.writeOccurred).toBe(false);
  });

  it("rejects persisted registry name and alias collisions", async () => {
    const runtimeHome = home();
    writeRegistry(runtimeHome, [
      record(),
      otherRecord({ historicalAliases: ["pi bmad builder"] }),
    ]);

    const result = await loadRegistry({ runtimeHome });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REGISTRY_NAME_COLLISION");
  });

  it("adds path aliases and known roots while preserving projectId", async () => {
    const runtimeHome = home();
    await upsertProjectRecord(record(), { runtimeHome });

    const added = await addProjectPathAlias(
      { projectId: "proj-1", pathAlias: "/work/builder-renamed", knownRoot: true },
      { runtimeHome },
    );

    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.writeOccurred).toBe(true);
    expect(added.value).toMatchObject({
      projectId: "proj-1",
      pathAlias: "/work/builder-renamed",
      added: true,
    });
    expect(added.value.registry.projects[0]).toMatchObject({
      projectId: "proj-1",
      pathAliases: ["builder", "/work/builder-renamed"],
      knownRoots: ["/work/builder", "/work/builder-renamed"],
    });
  });

  it("deduplicates equivalent path aliases without writing", async () => {
    const runtimeHome = home();
    await upsertProjectRecord(
      record({
        knownRoots: [String.raw`C:\Work\Builder`],
        artifactRoot: String.raw`C:\Work\Builder\_bmad-output`,
        runtimeStatePath: String.raw`C:\Work\Builder\.bmad-runtime\state.json`,
        pathAliases: [String.raw`C:\Work\Builder`],
      }),
      { runtimeHome },
    );

    const duplicate = await addProjectPathAlias(
      { projectId: "proj-1", pathAlias: "c:/work/builder" },
      { runtimeHome },
    );

    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) return;
    expect(duplicate.writeOccurred).toBe(false);
    expect(duplicate.value.added).toBe(false);
    expect(duplicate.value.registry.projects[0]?.pathAliases).toEqual([
      String.raw`C:\Work\Builder`,
    ]);
  });

  it("rejects non-path-like aliases without writing", async () => {
    const runtimeHome = home();
    await upsertProjectRecord(record(), { runtimeHome });

    const result = await addProjectPathAlias(
      { projectId: "proj-1", pathAlias: "friendly-name" },
      { runtimeHome },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REGISTRY_INVALID_SHAPE");
    expect(result.error.writeOccurred).toBe(false);
  });

  it("rejects relative and URL-like path aliases without writing", async () => {
    const runtimeHome = home();
    await upsertProjectRecord(record(), { runtimeHome });

    for (const pathAlias of [
      "foo/bar",
      "https://token@example.com/repo.git",
      "file:///tmp/repo",
      "C:",
    ]) {
      const result = await addProjectPathAlias(
        { projectId: "proj-1", pathAlias },
        { runtimeHome },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.writeOccurred).toBe(false);
    }
  });

  it("blocks path aliases that collide with another project", async () => {
    const runtimeHome = home();
    await upsertProjectRecord(record(), { runtimeHome });
    await upsertProjectRecord(otherRecord(), { runtimeHome });

    const result = await addProjectPathAlias(
      { projectId: "proj-1", pathAlias: "/work/other" },
      { runtimeHome },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.writeOccurred).toBe(false);
    expect(result.error.recoveryAction.action).toBe(
      "choose-non-conflicting-path-alias-and-retry",
    );
  });

  it("uses MSYS /c/foo, c/foo, and C:/foo path equivalence to preserve stable projectId", async () => {
    const runtimeHome = home();
    expect(
      (
        await upsertProjectRecord(
          record({
            projectId: "msys-proj",
            knownRoots: ["/c/foo"],
            artifactRoot: "/c/foo/_bmad-output/projects/pi-bmad-builder",
            runtimeStatePath: "/c/foo/.bmad-runtime/state.json",
            pathAliases: ["/c/foo"],
          }),
          { runtimeHome },
        )
      ).ok,
    ).toBe(true);

    const second = await upsertProjectRecord(
      record({
        projectId: "should-not-replace-msys-proj",
        displayName: "Drive Path Equivalent",
        knownRoots: ["c/foo"],
        artifactRoot: "c/foo/_bmad-output/projects/pi-bmad-builder",
        runtimeStatePath: "c/foo/.bmad-runtime/state.json",
        pathAliases: ["C:/foo"],
      }),
      { runtimeHome },
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.projects).toHaveLength(1);
    expect(second.value.projects[0]?.projectId).toBe("msys-proj");
  });

  it("generalizes MSYS drive equivalence beyond C drive", async () => {
    const runtimeHome = home();
    expect(
      (
        await upsertProjectRecord(
          record({
            projectId: "drive-d-proj",
            knownRoots: ["/d/foo"],
            artifactRoot: "/d/foo/_bmad-output/projects/pi-bmad-builder",
            runtimeStatePath: "/d/foo/.bmad-runtime/state.json",
            pathAliases: ["/d/foo"],
          }),
          { runtimeHome },
        )
      ).ok,
    ).toBe(true);

    const explicitDrive = await upsertProjectRecord(
      record({
        projectId: "should-not-replace-drive-d-proj",
        displayName: "D Drive Path Equivalent",
        knownRoots: ["D:/foo"],
        artifactRoot: "D:/foo/_bmad-output/projects/pi-bmad-builder",
        runtimeStatePath: "D:/foo/.bmad-runtime/state.json",
        pathAliases: ["D:/foo"],
      }),
      { runtimeHome },
    );
    expect(explicitDrive.ok).toBe(true);
    if (!explicitDrive.ok) return;
    expect(explicitDrive.value.projects).toHaveLength(1);
    expect(explicitDrive.value.projects[0]?.projectId).toBe("drive-d-proj");

    const driveRelative = await upsertProjectRecord(
      record({
        projectId: "should-still-not-replace-drive-d-proj",
        displayName: "D Drive Relative Equivalent",
        knownRoots: ["d/foo"],
        artifactRoot: "d/foo/_bmad-output/projects/pi-bmad-builder",
        runtimeStatePath: "d/foo/.bmad-runtime/state.json",
        pathAliases: ["d/foo"],
      }),
      { runtimeHome },
    );
    expect(driveRelative.ok).toBe(true);
    if (!driveRelative.ok) return;
    expect(driveRelative.value.projects).toHaveLength(1);
    expect(driveRelative.value.projects[0]?.projectId).toBe("drive-d-proj");
  });

  it("treats WSL /mnt drive paths as equivalent to Windows drive paths", async () => {
    const runtimeHome = home();
    expect(
      (
        await upsertProjectRecord(
          record({
            projectId: "wsl-proj",
            knownRoots: ["/mnt/c/work/builder"],
            artifactRoot: "/mnt/c/work/builder/_bmad-output/projects/pi-bmad-builder",
            runtimeStatePath: "/mnt/c/work/builder/.bmad-runtime/state.json",
            pathAliases: ["/mnt/c/work/builder"],
          }),
          { runtimeHome },
        )
      ).ok,
    ).toBe(true);

    const second = await upsertProjectRecord(
      record({
        projectId: "should-not-replace-wsl-proj",
        displayName: "WSL Path Equivalent",
        knownRoots: ["C:/work/builder"],
        artifactRoot: "C:/work/builder/_bmad-output/projects/pi-bmad-builder",
        runtimeStatePath: "C:/work/builder/.bmad-runtime/state.json",
        pathAliases: ["C:/work/builder"],
      }),
      { runtimeHome },
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.projects).toHaveLength(1);
    expect(second.value.projects[0]?.projectId).toBe("wsl-proj");
  });

  it("preserves UNC identity without colliding with POSIX-looking paths", async () => {
    const runtimeHome = home();
    expect(
      (
        await upsertProjectRecord(
          record({
            projectId: "unc-proj",
            knownRoots: [String.raw`\\server\share\builder`],
            artifactRoot: String.raw`\\server\share\builder\_bmad-output`,
            runtimeStatePath: String.raw`\\server\share\builder\.bmad-runtime\state.json`,
            pathAliases: [String.raw`\\server\share\builder`],
          }),
          { runtimeHome },
        )
      ).ok,
    ).toBe(true);

    const uncEquivalent = await upsertProjectRecord(
      record({
        projectId: "should-not-replace-unc-proj",
        displayName: "UNC Slash Equivalent",
        knownRoots: ["//server/share/builder"],
        artifactRoot: "//server/share/builder/_bmad-output",
        runtimeStatePath: "//server/share/builder/.bmad-runtime/state.json",
        pathAliases: ["//server/share/builder"],
      }),
      { runtimeHome },
    );
    expect(uncEquivalent.ok).toBe(true);
    if (!uncEquivalent.ok) return;
    expect(uncEquivalent.value.projects).toHaveLength(1);
    expect(uncEquivalent.value.projects[0]?.projectId).toBe("unc-proj");

    const posixLookalike = await upsertProjectRecord(
      record({
        projectId: "posix-lookalike-proj",
        displayName: "POSIX Lookalike",
        knownRoots: ["/server/share/builder"],
        artifactRoot: "/server/share/builder/_bmad-output",
        runtimeStatePath: "/server/share/builder/.bmad-runtime/state.json",
        pathAliases: ["/server/share/builder"],
      }),
      { runtimeHome },
    );
    expect(posixLookalike.ok).toBe(true);
    if (!posixLookalike.ok) return;
    expect(posixLookalike.value.projects).toHaveLength(2);
  });

  it("does not treat POSIX /a/app as equivalent to A:/app", async () => {
    const runtimeHome = home();
    expect(
      (
        await upsertProjectRecord(
          record({
            projectId: "posix-proj",
            knownRoots: ["/a/app"],
            artifactRoot: "/a/app/_bmad-output",
            runtimeStatePath: "/a/app/.bmad-runtime/state.json",
            pathAliases: ["/a/app"],
          }),
          { runtimeHome },
        )
      ).ok,
    ).toBe(true);

    const second = await upsertProjectRecord(
      record({
        projectId: "drive-proj",
        displayName: "Drive Project",
        knownRoots: ["A:/app"],
        artifactRoot: "A:/app/_bmad-output",
        runtimeStatePath: "A:/app/.bmad-runtime/state.json",
        pathAliases: ["A:/app"],
      }),
      { runtimeHome },
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.projects).toHaveLength(2);
    expect(second.value.projects.map((project) => project.projectId)).toEqual([
      "posix-proj",
      "drive-proj",
    ]);
  });

  it("rejects malformed optional persisted metadata instead of dropping it", async () => {
    const runtimeHome = home();
    writeRegistry(runtimeHome, [record({ currentStory: 123 })]);
    const malformedCurrentStory = await loadRegistry({ runtimeHome });
    expect(malformedCurrentStory.ok).toBe(false);
    if (!malformedCurrentStory.ok)
      expect(malformedCurrentStory.error.code).toBe("REGISTRY_INVALID_SHAPE");

    fs.writeFileSync(
      fileFor(runtimeHome),
      `${JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, projects: [record()], updatedAt: 123 }, null, 2)}
`,
      "utf8",
    );
    const malformedUpdatedAt = await loadRegistry({ runtimeHome });
    expect(malformedUpdatedAt.ok).toBe(false);
    if (!malformedUpdatedAt.ok)
      expect(malformedUpdatedAt.error.code).toBe("REGISTRY_INVALID_SHAPE");
  });

  it("rejects malformed persisted gitEvidence and targetRepos instead of dropping them", async () => {
    const runtimeHome = home();
    writeRegistry(runtimeHome, [record({ gitEvidence: "not-an-object" })]);
    const malformedGitEvidence = await loadRegistry({ runtimeHome });
    expect(malformedGitEvidence.ok).toBe(false);
    if (!malformedGitEvidence.ok)
      expect(malformedGitEvidence.error.code).toBe("REGISTRY_INVALID_SHAPE");

    writeRegistry(runtimeHome, [record({ gitEvidence: { branch: 42 } })]);
    const malformedGitEvidenceField = await loadRegistry({ runtimeHome });
    expect(malformedGitEvidenceField.ok).toBe(false);
    if (!malformedGitEvidenceField.ok)
      expect(malformedGitEvidenceField.error.code).toBe(
        "REGISTRY_INVALID_SHAPE",
      );

    writeRegistry(runtimeHome, [record({ targetRepos: "not-an-array" })]);
    const malformedTargetRepos = await loadRegistry({ runtimeHome });
    expect(malformedTargetRepos.ok).toBe(false);
    if (!malformedTargetRepos.ok)
      expect(malformedTargetRepos.error.code).toBe("REGISTRY_INVALID_SHAPE");

    writeRegistry(runtimeHome, [
      record({ targetRepos: [{ role: "runtime", path: "   " }] }),
    ]);
    const malformedTargetRepoPointer = await loadRegistry({ runtimeHome });
    expect(malformedTargetRepoPointer.ok).toBe(false);
    if (!malformedTargetRepoPointer.ok)
      expect(malformedTargetRepoPointer.error.code).toBe(
        "REGISTRY_INVALID_SHAPE",
      );
  });

  it("rejects raw remote URLs and malformed commits in git evidence", async () => {
    const runtimeHome = home();
    writeRegistry(runtimeHome, [
      record({
        gitEvidence: {
          remoteUrlFingerprint: "https://token@example.com/repo.git",
        },
      }),
    ]);
    const rawRemote = await loadRegistry({ runtimeHome });
    expect(rawRemote.ok).toBe(false);
    if (!rawRemote.ok)
      expect(rawRemote.error.code).toBe("REGISTRY_INVALID_SHAPE");

    writeRegistry(runtimeHome, [
      record({ gitEvidence: { commit: "not-a-commit" } }),
    ]);
    const badCommit = await loadRegistry({ runtimeHome });
    expect(badCommit.ok).toBe(false);
    if (!badCommit.ok)
      expect(badCommit.error.code).toBe("REGISTRY_INVALID_SHAPE");
  });

  it("rejects duplicate path-equivalent records with different projectIds as ambiguous", async () => {
    const runtimeHome = home();
    writeRegistry(runtimeHome, [
      record({
        projectId: "proj-a",
        knownRoots: ["/c/foo"],
        artifactRoot: "/c/foo/_bmad-output",
        runtimeStatePath: "/c/foo/.bmad-runtime/state.json",
      }),
      record({
        projectId: "proj-b",
        knownRoots: ["C:/foo"],
        artifactRoot: "C:/foo/_bmad-output",
        runtimeStatePath: "C:/foo/.bmad-runtime/state.json",
      }),
    ]);

    const ambiguous = await loadRegistry({ runtimeHome });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok)
      expect(ambiguous.error.code).toBe("REGISTRY_INVALID_SHAPE");
  });

  it("rejects whitespace-only knownRoots, pathAliases, historicalAliases, and registryPath", async () => {
    const runtimeHome = home();
    writeRegistry(runtimeHome, [
      record({ knownRoots: ["/work/builder", "   "] }),
    ]);
    const whitespaceKnownRoots = await loadRegistry({ runtimeHome });
    expect(whitespaceKnownRoots.ok).toBe(false);
    if (!whitespaceKnownRoots.ok)
      expect(whitespaceKnownRoots.error.code).toBe("REGISTRY_INVALID_SHAPE");

    writeRegistry(runtimeHome, [record({ pathAliases: ["builder", "	"] })]);
    const whitespacePathAliases = await loadRegistry({ runtimeHome });
    expect(whitespacePathAliases.ok).toBe(false);
    if (!whitespacePathAliases.ok)
      expect(whitespacePathAliases.error.code).toBe("REGISTRY_INVALID_SHAPE");

    writeRegistry(runtimeHome, [record({ historicalAliases: ["old", ""] })]);
    const whitespaceHistoricalAliases = await loadRegistry({ runtimeHome });
    expect(whitespaceHistoricalAliases.ok).toBe(false);
    if (!whitespaceHistoricalAliases.ok)
      expect(whitespaceHistoricalAliases.error.code).toBe(
        "REGISTRY_INVALID_SHAPE",
      );

    expect(() => resolveRegistryPath({ registryPath: "   " })).toThrow(
      /Registry path must not be empty/,
    );
    const emptyRegistryPath = await loadOrCreateRegistry({
      registryPath: "   ",
    });
    expect(emptyRegistryPath.ok).toBe(false);
    if (!emptyRegistryPath.ok)
      expect(emptyRegistryPath.error.code).toBe(
        "REGISTRY_RUNTIME_HOME_INVALID",
      );
  });

  it("waits for an existing registry lock file and removes lock after mutation", async () => {
    const runtimeHome = home();
    const registryPath = fileFor(runtimeHome);
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(`${registryPath}.lock`, "held", "utf8");
    setTimeout(() => fs.rmSync(`${registryPath}.lock`, { force: true }), 50);

    const result = await upsertProjectRecord(record(), { runtimeHome });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(`${registryPath}.lock`)).toBe(false);
  });

  it("returns structured failure when registry lock remains unavailable", async () => {
    const runtimeHome = home();
    const registryPath = fileFor(runtimeHome);
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(`${registryPath}.lock`, "held", "utf8");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const result = await loadOrCreateRegistry({ runtimeHome });
      await new Promise((resolve) => setImmediate(resolve));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("REGISTRY_LOCK_UNAVAILABLE");
        expect(result.error.writeOccurred).toBe(false);
        expect(result.error.recoveryAction.action).toBe(
          "remove-stale-registry-lock-and-retry",
        );
      }
      expect(fs.existsSync(registryPath)).toBe(false);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("returns structured lock failure when creating the lock directory fails", async () => {
    const runtimeHome = home();
    const impossibleRuntimeHome = path.join(runtimeHome, "not-a-directory");
    fs.writeFileSync(impossibleRuntimeHome, "file blocks mkdir", "utf8");

    const result = await loadOrCreateRegistry({
      runtimeHome: impossibleRuntimeHome,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REGISTRY_LOCK_UNAVAILABLE");
    expect(result.error.writeOccurred).toBe(false);
    expect(result.error.recoveryAction.action).toBe(
      "fix-registry-lock-path-and-retry",
    );
  });

  it("does not overwrite a registry that becomes corrupted between load and replace", async () => {
    const runtimeHome = home();
    expect(
      (
        await upsertProjectRecord(record({ projectId: "proj-safe" }), {
          runtimeHome,
        })
      ).ok,
    ).toBe(true);
    const corrupted = "{not valid json";

    const result = await upsertProjectRecord(
      record({
        projectId: "proj-new",
        displayName: "New Project",
        knownRoots: ["/work/new"],
        artifactRoot: "/work/new/_bmad-output",
        runtimeStatePath: "/work/new/.bmad-runtime/state.json",
      }),
      {
        runtimeHome,
        hooks: {
          beforeReplace: ({ registryPath }) =>
            fs.writeFileSync(registryPath, corrupted, "utf8"),
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REGISTRY_JSON_INVALID");
      expect(result.error.writeOccurred).toBe(true);
    }
    expect(fs.readFileSync(fileFor(runtimeHome), "utf8")).toBe(corrupted);
  });

  it("rejects canonical artifact content fields", async () => {
    const runtimeHome = home();
    const result = await upsertProjectRecord(
      record({ prd: "# PRD" }) as never,
      { runtimeHome },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CANONICAL_CONTENT_FIELD_REJECTED");
    expect(result.error.writeOccurred).toBe(false);
    expect(fs.existsSync(fileFor(runtimeHome))).toBe(false);
  });

  it("rejects disguised canonical artifact content fields while preserving allowed metadata names", async () => {
    const runtimeHome = home();
    writeRegistry(runtimeHome, [record({ prdMarkdown: "# PRD" })]);
    const disguisedCanonicalContent = await loadRegistry({ runtimeHome });
    expect(disguisedCanonicalContent.ok).toBe(false);
    if (!disguisedCanonicalContent.ok)
      expect(disguisedCanonicalContent.error.code).toBe(
        "CANONICAL_CONTENT_FIELD_REJECTED",
      );

    writeRegistry(runtimeHome, [
      record({
        artifactRoot: "/work/builder/_bmad-output/projects/pi-bmad-builder",
        runtimeStatePath: "/work/builder/.bmad-runtime/state.json",
        historicalAliases: ["old-builder"],
        targetRepos: [{ role: "runtime", path: "/work/runtime" }],
        lastWorkflow: "bmad-dev-story",
        currentStory: "1.1",
      }),
    ]);
    const allowedMetadata = await loadRegistry({ runtimeHome });
    expect(allowedMetadata.ok).toBe(true);
  });

  it("rejects unsupported schema fields instead of silently dropping them", async () => {
    const runtimeHome = home();
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(
      fileFor(runtimeHome),
      `${JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, projects: [], notes: "metadata?" }, null, 2)}
`,
      "utf8",
    );
    const unknownRoot = await loadRegistry({ runtimeHome });
    expect(unknownRoot.ok).toBe(false);
    if (!unknownRoot.ok)
      expect(unknownRoot.error.code).toBe("REGISTRY_INVALID_SHAPE");

    writeRegistry(runtimeHome, [record({ notes: "possibly canonical content" })]);
    const unknownProjectField = await loadRegistry({ runtimeHome });
    expect(unknownProjectField.ok).toBe(false);
    if (!unknownProjectField.ok)
      expect(unknownProjectField.error.code).toBe("REGISTRY_INVALID_SHAPE");

    writeRegistry(runtimeHome, [
      record({ gitEvidence: { branch: "main", unknown: "field" } }),
    ]);
    const unknownGitEvidenceField = await loadRegistry({ runtimeHome });
    expect(unknownGitEvidenceField.ok).toBe(false);
    if (!unknownGitEvidenceField.ok)
      expect(unknownGitEvidenceField.error.code).toBe(
        "REGISTRY_INVALID_SHAPE",
      );

    writeRegistry(runtimeHome, [
      record({ targetRepos: [{ role: "runtime", path: "/work/runtime", label: "x" }] }),
    ]);
    const unknownTargetRepoField = await loadRegistry({ runtimeHome });
    expect(unknownTargetRepoField.ok).toBe(false);
    if (!unknownTargetRepoField.ok)
      expect(unknownTargetRepoField.error.code).toBe(
        "REGISTRY_INVALID_SHAPE",
      );

    fs.writeFileSync(
      fileFor(runtimeHome),
      `${JSON.stringify(
        {
          schemaVersion: REGISTRY_SCHEMA_VERSION,
          projects: [],
          recovery: {
            action: "restore",
            reason: "test",
            timestamp: "2026-06-08T00:00:00.000Z",
            extra: "field",
          },
        },
        null,
        2,
      )}
`,
      "utf8",
    );
    const unknownRecoveryField = await loadRegistry({ runtimeHome });
    expect(unknownRecoveryField.ok).toBe(false);
    if (!unknownRecoveryField.ok)
      expect(unknownRecoveryField.error.code).toBe("REGISTRY_INVALID_SHAPE");
  });

  it("returns structured schema errors without overwriting", async () => {
    const runtimeHome = home();
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(
      fileFor(runtimeHome),
      `${JSON.stringify({ projects: [] }, null, 2)}\n`,
      "utf8",
    );
    const missing = await loadRegistry({ runtimeHome });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("REGISTRY_SCHEMA_MISSING");
    expect(JSON.parse(fs.readFileSync(fileFor(runtimeHome), "utf8"))).toEqual({
      projects: [],
    });

    fs.writeFileSync(
      fileFor(runtimeHome),
      `${JSON.stringify({ schemaVersion: 999, projects: [] }, null, 2)}\n`,
      "utf8",
    );
    const unsupported = await loadRegistry({ runtimeHome });
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      expect(unsupported.error.code).toBe("REGISTRY_SCHEMA_UNSUPPORTED");
      expect(unsupported.error.writeOccurred).toBe(false);
    }
    expect(JSON.parse(fs.readFileSync(fileFor(runtimeHome), "utf8"))).toEqual({
      schemaVersion: 999,
      projects: [],
    });
  });

  it("returns structured invalid JSON errors without overwriting original file", async () => {
    const runtimeHome = home();
    fs.mkdirSync(runtimeHome, { recursive: true });
    const original = '{"schemaVersion":1,"projects":[\n';
    fs.writeFileSync(fileFor(runtimeHome), original, "utf8");
    const result = await loadRegistry({ runtimeHome });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REGISTRY_JSON_INVALID");
    expect(result.error.writeOccurred).toBe(false);
    expect(result.error.recoveryAction.action).toBe(
      "inspect-or-restore-registry-from-backup",
    );
    expect(fs.readFileSync(fileFor(runtimeHome), "utf8")).toBe(original);
  });

  it("returns structured shape errors for excessive metadata nesting", async () => {
    const runtimeHome = home();
    let nested: unknown = "main";
    for (let index = 0; index < 100; index += 1)
      nested = { branch: nested };
    writeRegistry(runtimeHome, [record({ gitEvidence: nested })]);

    const result = await loadRegistry({ runtimeHome });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REGISTRY_INVALID_SHAPE");
      expect(result.error.writeOccurred).toBe(false);
    }
  });

  it("serializes concurrent in-process upserts and preserves all records", async () => {
    const runtimeHome = home();
    const results = await Promise.all(
      ["a", "b", "c", "d", "e"].map((suffix) =>
        upsertProjectRecord(
          record({
            projectId: `proj-${suffix}`,
            displayName: `Project ${suffix}`,
            knownRoots: [`/work/${suffix}`],
            artifactRoot: `/work/${suffix}/_bmad-output`,
            runtimeStatePath: `/work/${suffix}/.bmad-runtime/state.json`,
            pathAliases: [`alias-${suffix}`],
          }),
          { runtimeHome },
        ),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const parsed = await loadRegistry({ runtimeHome });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      parsed.value.projects.map((project) => project.projectId).sort(),
    ).toEqual(["proj-a", "proj-b", "proj-c", "proj-d", "proj-e"]);
  });

  it("rejects empty runtimeHome instead of creating registry in cwd", async () => {
    const result = await loadOrCreateRegistry({ runtimeHome: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REGISTRY_RUNTIME_HOME_INVALID");
    expect(result.error.writeOccurred).toBe(false);
    expect(result.error.recoveryAction.action).toBe(
      "provide-non-empty-runtime-home-or-registry-path",
    );
  });

  it("rejects duplicate or empty projectId and invalid or missing lastSeenAt in persisted registry", async () => {
    const runtimeHome = home();
    writeRegistry(runtimeHome, [
      record({ projectId: "dup" }),
      record({ projectId: "dup" }),
    ]);
    const duplicate = await loadRegistry({ runtimeHome });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok)
      expect(duplicate.error.code).toBe("REGISTRY_INVALID_SHAPE");

    writeRegistry(runtimeHome, [record({ projectId: "" })]);
    const emptyProjectId = await loadRegistry({ runtimeHome });
    expect(emptyProjectId.ok).toBe(false);
    if (!emptyProjectId.ok)
      expect(emptyProjectId.error.code).toBe("REGISTRY_INVALID_SHAPE");

    writeRegistry(runtimeHome, [record({ lastSeenAt: "not-a-date" })]);
    const invalidTimestamp = await loadRegistry({ runtimeHome });
    expect(invalidTimestamp.ok).toBe(false);
    if (!invalidTimestamp.ok)
      expect(invalidTimestamp.error.code).toBe("REGISTRY_INVALID_SHAPE");

    const { lastSeenAt: _lastSeenAt, ...withoutLastSeenAt } = record();
    writeRegistry(runtimeHome, [withoutLastSeenAt]);
    const missingTimestamp = await loadRegistry({ runtimeHome });
    expect(missingTimestamp.ok).toBe(false);
    if (!missingTimestamp.ok)
      expect(missingTimestamp.error.code).toBe("REGISTRY_INVALID_SHAPE");
  });

  it("rejects malformed array elements instead of dropping them", async () => {
    const runtimeHome = home();
    writeRegistry(runtimeHome, [record({ knownRoots: ["/work/builder", 42] })]);
    const malformedKnownRoots = await loadRegistry({ runtimeHome });
    expect(malformedKnownRoots.ok).toBe(false);
    if (!malformedKnownRoots.ok)
      expect(malformedKnownRoots.error.code).toBe("REGISTRY_INVALID_SHAPE");

    const malformedInput = await upsertProjectRecord(
      record({ pathAliases: ["builder", false] }) as never,
      { runtimeHome: home() },
    );
    expect(malformedInput.ok).toBe(false);
    if (!malformedInput.ok) {
      expect(malformedInput.error.code).toBe("REGISTRY_INVALID_SHAPE");
      expect(malformedInput.error.writeOccurred).toBe(false);
    }
  });

  it("preserves last valid registry after interrupted write and allows idempotent retry", async () => {
    const runtimeHome = home();
    expect(
      (
        await upsertProjectRecord(record({ projectId: "proj-safe" }), {
          runtimeHome,
        })
      ).ok,
    ).toBe(true);
    const beforeFailure = fs.readFileSync(fileFor(runtimeHome), "utf8");
    const interrupted = await upsertProjectRecord(
      record({
        projectId: "proj-new",
        displayName: "New Project",
        knownRoots: ["/work/new"],
        artifactRoot: "/work/new/_bmad-output",
        runtimeStatePath: "/work/new/.bmad-runtime/state.json",
      }),
      {
        runtimeHome,
        hooks: {
          afterTempWrite: () => {
            throw new Error("simulated interruption");
          },
        },
      },
    );
    expect(interrupted.ok).toBe(false);
    if (!interrupted.ok)
      expect(interrupted.error.recoveryAction.action).toBe(
        "retry-idempotent-update-after-preserving-last-valid-registry",
      );
    expect(fs.readFileSync(fileFor(runtimeHome), "utf8")).toBe(beforeFailure);
    expect((await loadRegistry({ runtimeHome })).ok).toBe(true);

    const retry = await upsertProjectRecord(
      record({
        projectId: "proj-new",
        displayName: "New Project",
        knownRoots: ["/work/new"],
        artifactRoot: "/work/new/_bmad-output",
        runtimeStatePath: "/work/new/.bmad-runtime/state.json",
      }),
      { runtimeHome },
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(
      retry.value.projects.map((project) => project.projectId).sort(),
    ).toEqual(["proj-new", "proj-safe"]);
  });

  it("reports writeOccurred when an interrupted update already wrote a backup", async () => {
    const runtimeHome = home();
    expect(
      (
        await upsertProjectRecord(record({ projectId: "proj-safe" }), {
          runtimeHome,
        })
      ).ok,
    ).toBe(true);

    const interrupted = await upsertProjectRecord(record({ projectId: "proj-new" }), {
      runtimeHome,
      hooks: {
        afterTempWrite: () => {
          throw new Error("simulated interruption after backup");
        },
      },
    });

    expect(interrupted.ok).toBe(false);
    if (!interrupted.ok) expect(interrupted.error.writeOccurred).toBe(true);
  });
});
