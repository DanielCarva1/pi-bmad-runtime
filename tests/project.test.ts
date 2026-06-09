import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureProjectInitialized,
  ensureProjectRegistered,
  getBaselineLockFile,
  getProjectIdentityFile,
  preflightPhysicalFolderRename,
  registerCurrentProjectPathAlias,
  renameRegisteredProject,
} from "../extensions/bmad-runtime/project.js";
import { loadRegistry } from "../extensions/bmad-runtime/registry.js";
import { getStateFile } from "../extensions/bmad-runtime/state.js";

let tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-project-init-"));
  tempDirs.push(root);
  return root;
}

function makeGitRepo(root: string, remote: string): void {
  const git = path.join(root, ".git");
  fs.mkdirSync(path.join(git, "refs", "heads"), { recursive: true });
  fs.writeFileSync(
    path.join(git, "config"),
    `[remote "origin"]\n\turl = ${remote}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n", "utf8");
  fs.writeFileSync(
    path.join(git, "refs", "heads", "main"),
    "0123456789abcdef0123456789abcdef01234567\n",
    "utf8",
  );
}

function makeGitFileRepo(root: string, remote: string): void {
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-gitdir-"));
  tempDirs.push(gitDir);
  fs.writeFileSync(path.join(root, ".git"), `gitdir: ${gitDir}\n`, "utf8");
  fs.writeFileSync(
    path.join(gitDir, "config"),
    `[remote "origin"]\n\turl = ${remote}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  fs.writeFileSync(
    path.join(gitDir, "packed-refs"),
    "# pack-refs with: peeled fully-peeled sorted\nabcdefabcdefabcdefabcdefabcdefabcdefabcd refs/heads/main\n",
    "utf8",
  );
}

function makeLinkedWorktreeRepo(root: string, remote: string): void {
  const commonDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-common-git-"));
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-worktree-git-"));
  tempDirs.push(commonDir, gitDir);
  fs.mkdirSync(path.join(commonDir, "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git"), `gitdir: ${gitDir}\n`, "utf8");
  fs.writeFileSync(path.join(gitDir, "commondir"), `${commonDir}\n`, "utf8");
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  fs.writeFileSync(
    path.join(commonDir, "config"),
    `[remote "origin"]\n\turl = ${remote}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(commonDir, "refs", "heads", "main"),
    "fedcba9876543210fedcba9876543210fedcba98\n",
    "utf8",
  );
}

function makeMultiRemoteGitRepo(root: string): void {
  const git = path.join(root, ".git");
  fs.mkdirSync(path.join(git, "refs", "heads"), { recursive: true });
  fs.writeFileSync(
    path.join(git, "config"),
    `[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[remote "backup"]\n\turl = https://token:secret@example.com/backup.git\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n", "utf8");
  fs.writeFileSync(
    path.join(git, "refs", "heads", "main"),
    "0123456789abcdef0123456789abcdef01234567\n",
    "utf8",
  );
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("ensureProjectInitialized", () => {
  it("creates runtime state, project identity, baseline lock, and artifact roots", () => {
    const root = makeRoot();
    const result = ensureProjectInitialized(root);

    expect(fs.existsSync(getStateFile(root))).toBe(true);
    expect(fs.existsSync(getProjectIdentityFile(root))).toBe(true);
    expect(fs.existsSync(getBaselineLockFile(root))).toBe(true);
    expect(fs.existsSync(path.join(root, "_bmad-output", "planning-artifacts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "_bmad-output", "implementation-artifacts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "docs"))).toBe(true);
    expect(result.identity.projectId).toMatch(/[0-9a-f-]{36}/i);
    expect(result.created).toContain(".bmad-runtime/state.json");
    expect(result.created).toContain(".bmad-runtime/project-identity.json");
    expect(result.created).toContain(".bmad-runtime/baseline-lock.json");
  });

  it("is idempotent and preserves an existing project id", () => {
    const root = makeRoot();
    const first = ensureProjectInitialized(root);
    const second = ensureProjectInitialized(root);

    expect(second.identity.projectId).toBe(first.identity.projectId);
    expect(second.created).toHaveLength(0);
    expect(second.reused).toContain(".bmad-runtime/project-identity.json");
    expect(second.reused).toContain(".bmad-runtime/baseline-lock.json");
  });

  it("does not overwrite existing runtime state", () => {
    const root = makeRoot();
    ensureProjectInitialized(root);
    const stateFile = getStateFile(root);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    state.track = "custom";
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    ensureProjectInitialized(root);

    const after = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    expect(after.track).toBe("custom");
  });

  it("registers the local stable project id in the global registry", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();

    const result = await ensureProjectRegistered(root, { runtimeHome });

    expect(result.registry.ok).toBe(true);
    if (!result.registry.ok) return;
    expect(result.registry.value.projects).toHaveLength(1);
    expect(result.registry.value.projects[0]).toMatchObject({
      projectId: result.identity.projectId,
      displayName: result.identity.projectName,
      knownRoots: [root],
      artifactRoot: path.join(root, "_bmad-output"),
      runtimeStatePath: getStateFile(root),
      pathAliases: [root],
    });
    expect(result.registry.value.projects[0]?.lastSeenAt).toEqual(
      expect.any(String),
    );
  });

  it("preserves the same stable project id across repeated registration", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();

    const first = await ensureProjectRegistered(root, { runtimeHome });
    const second = await ensureProjectRegistered(root, { runtimeHome });

    expect(first.identity.projectId).toBe(second.identity.projectId);
    expect(second.registry.ok).toBe(true);
    if (!second.registry.ok) return;
    expect(second.registry.value.projects).toHaveLength(1);
    expect(second.registry.value.projects[0]?.projectId).toBe(
      first.identity.projectId,
    );
  });

  it("can identify the same project from persisted registry, state, and identity files without chat memory", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const registered = await ensureProjectRegistered(root, { runtimeHome });
    expect(registered.registry.ok).toBe(true);

    const identity = JSON.parse(
      fs.readFileSync(getProjectIdentityFile(root), "utf8"),
    ) as { projectId: string };
    const state = JSON.parse(fs.readFileSync(getStateFile(root), "utf8")) as {
      version: number;
    };
    const registry = await loadRegistry({ runtimeHome });

    expect(state.version).toBe(1);
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    expect(registry.value.projects[0]?.projectId).toBe(identity.projectId);
    expect(identity.projectId).toBe(registered.identity.projectId);
  });

  it("stores git remote fingerprint without leaking the raw remote URL into registry JSON", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const remote = "https://token:secret@example.com/acme/runtime.git";
    makeGitRepo(root, remote);

    const result = await ensureProjectRegistered(root, { runtimeHome });

    expect(result.registry.ok).toBe(true);
    if (!result.registry.ok) return;
    const project = result.registry.value.projects[0];
    expect(project?.gitEvidence).toMatchObject({
      branch: "main",
      worktreePath: root,
      commit: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(project?.gitEvidence?.remoteUrlFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const rawRegistry = fs.readFileSync(
      path.join(runtimeHome, "projects.json"),
      "utf8",
    );
    expect(rawRegistry).not.toContain(remote);
    expect(rawRegistry).not.toContain("token:secret");
    const rawIdentity = fs.readFileSync(getProjectIdentityFile(root), "utf8");
    expect(rawIdentity).not.toContain(remote);
    expect(rawIdentity).not.toContain("token:secret");
    expect(rawIdentity).toContain("gitRemoteFingerprint");
  });

  it("captures bounded git evidence from gitdir pointer and packed refs", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    makeGitFileRepo(root, "git@example.com:acme/runtime.git");

    const result = await ensureProjectRegistered(root, { runtimeHome });

    expect(result.registry.ok).toBe(true);
    if (!result.registry.ok) return;
    expect(result.registry.value.projects[0]?.gitEvidence).toMatchObject({
      branch: "main",
      commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      worktreePath: root,
    });
  });

  it("captures git evidence from a nested project inside a git working tree", async () => {
    const gitRoot = makeRoot();
    const root = path.join(gitRoot, "packages", "runtime-project");
    fs.mkdirSync(root, { recursive: true });
    const runtimeHome = makeRoot();
    makeGitRepo(gitRoot, "git@example.com:acme/runtime.git");

    const result = await ensureProjectRegistered(root, { runtimeHome });

    expect(result.registry.ok).toBe(true);
    if (!result.registry.ok) return;
    expect(result.registry.value.projects[0]?.gitEvidence).toMatchObject({
      branch: "main",
      commit: "0123456789abcdef0123456789abcdef01234567",
      worktreePath: gitRoot,
    });
    expect(result.registry.value.projects[0]?.gitEvidence?.remoteUrlFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("captures linked worktree evidence from commondir without bleeding into other remotes", async () => {
    const gitRoot = makeRoot();
    const runtimeHome = makeRoot();
    makeLinkedWorktreeRepo(gitRoot, "git@example.com:acme/common.git");

    const result = await ensureProjectRegistered(gitRoot, { runtimeHome });

    expect(result.registry.ok).toBe(true);
    if (!result.registry.ok) return;
    expect(result.registry.value.projects[0]?.gitEvidence).toMatchObject({
      branch: "main",
      commit: "fedcba9876543210fedcba9876543210fedcba98",
      worktreePath: gitRoot,
    });
    expect(result.registry.value.projects[0]?.gitEvidence?.remoteUrlFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not fingerprint a non-origin remote when origin has no url", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    makeMultiRemoteGitRepo(root);

    const result = await ensureProjectRegistered(root, { runtimeHome });

    expect(result.registry.ok).toBe(true);
    if (!result.registry.ok) return;
    expect(result.registry.value.projects[0]?.gitEvidence?.remoteUrlFingerprint).toBeUndefined();
  });

  it("omits git evidence when no local git metadata is available", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();

    const result = await ensureProjectRegistered(root, { runtimeHome });

    expect(result.registry.ok).toBe(true);
    if (!result.registry.ok) return;
    expect(result.registry.value.projects[0]?.gitEvidence).toBeUndefined();
  });

  it("registers a path alias for the current project without changing stable id", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const registered = await ensureProjectRegistered(root, { runtimeHome });
    const aliasPath = path.join(path.dirname(root), "runtime-moved");

    const result = await registerCurrentProjectPathAlias(root, aliasPath, {
      runtimeHome,
      knownRoot: true,
    });

    expect(result.registry.ok).toBe(true);
    if (!result.registry.ok) return;
    expect(result.registry.value.projectId).toBe(registered.identity.projectId);
    expect(result.registry.value.registry.projects[0]?.projectId).toBe(
      registered.identity.projectId,
    );
    expect(result.registry.value.registry.projects[0]?.pathAliases).toContain(
      aliasPath,
    );
    expect(result.registry.value.registry.projects[0]?.knownRoots).toContain(
      aliasPath,
    );
  });

  it("does not mutate registry when current project path alias collides", async () => {
    const root = makeRoot();
    const otherRoot = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(root, { runtimeHome });
    await ensureProjectRegistered(otherRoot, { runtimeHome });
    const before = await loadRegistry({ runtimeHome });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const result = await registerCurrentProjectPathAlias(root, otherRoot, {
      runtimeHome,
    });

    expect(result.registry.ok).toBe(false);
    if (!result.registry.ok) {
      expect(result.registry.error.writeOccurred).toBe(false);
    }
    const after = await loadRegistry({ runtimeHome });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(JSON.stringify(after.value)).toBe(JSON.stringify(before.value));
  });

  it("does not initialize a new project when path alias preflight fails", async () => {
    const root = makeRoot();
    const otherRoot = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(otherRoot, { runtimeHome });

    const result = await registerCurrentProjectPathAlias(root, otherRoot, {
      runtimeHome,
    });

    expect(result.registry.ok).toBe(false);
    expect(fs.existsSync(getProjectIdentityFile(root))).toBe(false);
    expect(fs.existsSync(getStateFile(root))).toBe(false);
  });

  it("repairs incomplete identity metadata while preserving the existing stable id", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    fs.mkdirSync(path.dirname(getProjectIdentityFile(root)), { recursive: true });
    fs.writeFileSync(
      getProjectIdentityFile(root),
      `${JSON.stringify({ version: 1, projectId: "stable-id", projectName: "Legacy" }, null, 2)}\n`,
      "utf8",
    );

    const result = await ensureProjectRegistered(root, { runtimeHome });

    expect(result.identity.projectId).toBe("stable-id");
    expect(result.identity.rootFingerprint.initialPath).toBe(root);
    expect(result.registry.ok).toBe(true);
  });

  it("repairs a baseline lock that diverged from the stable identity", async () => {
    const root = makeRoot();
    const first = ensureProjectInitialized(root);
    const baselineFile = getBaselineLockFile(root);
    const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8")) as Record<string, unknown>;
    baseline.projectId = "wrong-id";
    fs.writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

    const result = await ensureProjectRegistered(root, { runtimeHome: makeRoot() });
    const repaired = JSON.parse(fs.readFileSync(baselineFile, "utf8")) as { projectId: string };

    expect(result.identity.projectId).toBe(first.identity.projectId);
    expect(repaired.projectId).toBe(first.identity.projectId);
  });

  it("fails without writing when registry path match conflicts with local stable id", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const first = await ensureProjectRegistered(root, { runtimeHome });
    expect(first.registry.ok).toBe(true);
    const identity = JSON.parse(fs.readFileSync(getProjectIdentityFile(root), "utf8")) as Record<string, unknown>;
    identity.projectId = "different-local-id";
    fs.writeFileSync(getProjectIdentityFile(root), `${JSON.stringify(identity, null, 2)}\n`, "utf8");

    const second = await ensureProjectRegistered(root, { runtimeHome });

    expect(second.registry.ok).toBe(false);
    if (!second.registry.ok) {
      expect(second.registry.error.code).toBe("REGISTRY_INVALID_SHAPE");
      expect(second.registry.error.writeOccurred).toBe(false);
      expect(second.registry.error.recoveryAction.action).toBe(
        "resolve-project-id-conflict-before-retry",
      );
    }
    const registry = await loadRegistry({ runtimeHome });
    expect(registry.ok).toBe(true);
    if (!registry.ok || !first.registry.ok) return;
    expect(registry.value.projects[0]?.projectId).toBe(
      first.registry.value.projects[0]?.projectId,
    );
  });

  it("renames the current project in registry and local identity without changing stable id", async () => {
    const root = makeRoot();
    const folderNameBefore = path.basename(root);
    const runtimeHome = makeRoot();
    const registered = await ensureProjectRegistered(root, { runtimeHome });
    const projectId = registered.identity.projectId;

    const renamed = await renameRegisteredProject(root, "Renamed Runtime", {
      runtimeHome,
    });

    expect(renamed.registry.ok).toBe(true);
    expect(renamed.identity?.projectId).toBe(projectId);
    expect(renamed.identity?.projectName).toBe("Renamed Runtime");
    expect(path.basename(root)).toBe(folderNameBefore);
    expect(fs.existsSync(root)).toBe(true);
    const identity = JSON.parse(
      fs.readFileSync(getProjectIdentityFile(root), "utf8"),
    ) as { projectId: string; projectName: string };
    expect(identity).toMatchObject({ projectId, projectName: "Renamed Runtime" });

    const afterRegistration = await ensureProjectRegistered(root, { runtimeHome });
    expect(afterRegistration.registry.ok).toBe(true);
    if (!afterRegistration.registry.ok) return;
    expect(afterRegistration.registry.value.projects[0]).toMatchObject({
      projectId,
      displayName: "Renamed Runtime",
      historicalAliases: [registered.identity.projectName],
    });
  });

  it("preflights explicit physical folder rename without mutating registry, identity, or folders", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const registered = await ensureProjectRegistered(root, { runtimeHome });
    const targetFolder = "renamed-physical-root";
    const targetPath = path.join(path.dirname(root), targetFolder);
    const identityBefore = fs.readFileSync(getProjectIdentityFile(root), "utf8");
    const registryBefore = await loadRegistry({ runtimeHome });
    expect(registryBefore.ok).toBe(true);
    if (!registryBefore.ok) return;
    const registryBeforeText = JSON.stringify(registryBefore.value);

    const result = await preflightPhysicalFolderRename(root, targetFolder, {
      runtimeHome,
      explicitConfirmation: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.writeOccurred).toBe(false);
    expect(result.projectId).toBe(registered.identity.projectId);
    expect(result.displayName).toBe(registered.identity.projectName);
    expect(result.currentWorkspacePath).toBe(root);
    expect(result.targetWorkspacePath).toBe(targetPath);
    expect(result.nextSafeAction).toContain("/bmad-start");
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.readFileSync(getProjectIdentityFile(root), "utf8")).toBe(identityBefore);
    const registryAfter = await loadRegistry({ runtimeHome });
    expect(registryAfter.ok).toBe(true);
    if (!registryAfter.ok) return;
    expect(JSON.stringify(registryAfter.value)).toBe(registryBeforeText);
  });

  it("blocks physical folder rename without explicit confirmation", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(root, { runtimeHome });
    const identityBefore = fs.readFileSync(getProjectIdentityFile(root), "utf8");

    const result = await preflightPhysicalFolderRename(root, "needs-confirmation", {
      runtimeHome,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.writeOccurred).toBe(false);
    expect(result.recoveryAction).toBe("rerun-with---confirm-folder-rename");
    expect(result.error).toContain("explicit confirmation");
    expect(fs.readFileSync(getProjectIdentityFile(root), "utf8")).toBe(identityBefore);
  });

  it("blocks path-like physical folder names before mutation", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(root, { runtimeHome });
    const identityBefore = fs.readFileSync(getProjectIdentityFile(root), "utf8");

    const result = await preflightPhysicalFolderRename(root, "../display-name-as-path", {
      runtimeHome,
      explicitConfirmation: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.writeOccurred).toBe(false);
    expect(result.recoveryAction).toBe("provide-single-safe-folder-name");
    expect(result.error).toContain("path");
    expect(fs.readFileSync(getProjectIdentityFile(root), "utf8")).toBe(identityBefore);
  });

  it("blocks physical folder rename when runtime artifact config diverges from identity and registry", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(root, { runtimeHome });
    const identityBefore = fs.readFileSync(getProjectIdentityFile(root), "utf8");
    const registryBefore = await loadRegistry({ runtimeHome });
    expect(registryBefore.ok).toBe(true);
    if (!registryBefore.ok) return;
    const registryBeforeText = JSON.stringify(registryBefore.value);
    fs.mkdirSync(path.join(root, "_bmad", "bmm"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "_bmad", "bmm", "config.yaml"),
      "output_folder: custom-output\n",
      "utf8",
    );

    const result = await preflightPhysicalFolderRename(root, "renamed-root", {
      runtimeHome,
      explicitConfirmation: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.writeOccurred).toBe(false);
    expect(result.recoveryAction).toBe(
      "repair-project-identity-output-root-before-folder-rename",
    );
    expect(result.error).toContain("output root");
    expect(fs.readFileSync(getProjectIdentityFile(root), "utf8")).toBe(identityBefore);
    const registryAfter = await loadRegistry({ runtimeHome });
    expect(registryAfter.ok).toBe(true);
    if (!registryAfter.ok) return;
    expect(JSON.stringify(registryAfter.value)).toBe(registryBeforeText);
  });

  it("does not mutate local identity when rename is blocked by registry collision", async () => {
    const root = makeRoot();
    const otherRoot = makeRoot();
    const runtimeHome = makeRoot();
    const registered = await ensureProjectRegistered(root, { runtimeHome });
    await ensureProjectRegistered(otherRoot, { runtimeHome });
    const otherIdentity = JSON.parse(
      fs.readFileSync(getProjectIdentityFile(otherRoot), "utf8"),
    ) as { projectName: string };
    const before = fs.readFileSync(getProjectIdentityFile(root), "utf8");
    const registryBefore = await loadRegistry({ runtimeHome });
    expect(registryBefore.ok).toBe(true);
    if (!registryBefore.ok) return;
    const registryBeforeText = JSON.stringify(registryBefore.value);

    const renamed = await renameRegisteredProject(root, otherIdentity.projectName, {
      runtimeHome,
    });

    expect(renamed.registry.ok).toBe(false);
    if (!renamed.registry.ok)
      expect(renamed.registry.error.writeOccurred).toBe(false);
    expect(fs.readFileSync(getProjectIdentityFile(root), "utf8")).toBe(before);
    const registryAfter = await loadRegistry({ runtimeHome });
    expect(registryAfter.ok).toBe(true);
    if (!registryAfter.ok) return;
    expect(JSON.stringify(registryAfter.value)).toBe(registryBeforeText);
    const identity = JSON.parse(before) as { projectId: string; projectName: string };
    expect(identity.projectId).toBe(registered.identity.projectId);
    expect(identity.projectName).toBe(registered.identity.projectName);
  });

  it("returns structured registry failure without destroying local identity files", async () => {
    const root = makeRoot();

    const result = await ensureProjectRegistered(root, { registryPath: "   " });

    expect(result.registry.ok).toBe(false);
    if (!result.registry.ok) {
      expect(result.registry.error.code).toBe("REGISTRY_RUNTIME_HOME_INVALID");
      expect(result.registry.error.writeOccurred).toBe(false);
    }
    expect(fs.existsSync(getStateFile(root))).toBe(true);
    expect(fs.existsSync(getProjectIdentityFile(root))).toBe(true);
    expect(fs.existsSync(getBaselineLockFile(root))).toBe(true);
  });
});
