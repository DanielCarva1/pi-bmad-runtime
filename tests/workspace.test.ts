import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectRegistryRecord } from "../extensions/bmad-runtime/registry.js";
import { getStateFile, loadState } from "../extensions/bmad-runtime/state.js";
import { buildDedicatedWorkspacePath, createDedicatedWorkspace, deriveShortId, resolveDedicatedWorkspaceRoot, slugProjectName } from "../extensions/bmad-runtime/workspace.js";

let tempDirs: string[] = [];

function makeRoot(prefix = "pi-bmad-workspace-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function registryFile(runtimeHome: string): string {
  return path.join(runtimeHome, "projects.json");
}

function readRegistry(runtimeHome: string): { projects: ProjectRegistryRecord[] } {
  return JSON.parse(fs.readFileSync(registryFile(runtimeHome), "utf8")) as { projects: ProjectRegistryRecord[] };
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("dedicated local workspace", () => {
  it("resolves default and preferred roots", () => {
    expect(resolveDedicatedWorkspaceRoot().root).toBe(path.join(os.homedir(), "bmad-projects"));
    const preferred = makeRoot();
    expect(resolveDedicatedWorkspaceRoot({ rootPreference: preferred }).root).toBe(path.resolve(preferred));
    expect(resolveDedicatedWorkspaceRoot({ rootPreference: preferred, rootSource: "flag" }).source).toBe("flag");
  });

  it("loads global dedicated root preference from Runtime Home", () => {
    const runtimeHome = makeRoot();
    const preferred = makeRoot();
    fs.writeFileSync(path.join(runtimeHome, "preferences.json"), JSON.stringify({ dedicatedWorkspaceRoot: preferred }), "utf8");

    const resolved = resolveDedicatedWorkspaceRoot({ runtimeHome });

    expect(resolved.root).toBe(path.resolve(preferred));
    expect(resolved.source).toBe("preference");
  });

  it("builds a stable slug plus shortid path from the project id", () => {
    const root = makeRoot();
    const projectId = "11111111-2222-4333-8444-555555555555";
    const layout = buildDedicatedWorkspacePath({ projectName: "My New App", projectId, rootPreference: root });

    expect(slugProjectName("My New App")).toBe("my-new-app");
    expect(layout.shortId).toBe(deriveShortId(projectId));
    expect(path.basename(layout.workspacePath)).toBe(`my-new-app--${deriveShortId(projectId)}`);
  });

  it.each(["", "../escape", "a/b", "a\\b", "..."])("rejects invalid project name %j without writes", async (projectName) => {
    const root = makeRoot();
    const result = await createDedicatedWorkspace({ cwd: makeRoot(), projectName, rootPreference: root }, { runtimeHome: makeRoot() });

    expect(result.ok).toBe(false);
    expect(result.writeOccurred).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("creates project identity, baseline, artifacts, registry and evidence under a dedicated root", async () => {
    const source = makeRoot();
    const root = makeRoot();
    const runtimeHome = makeRoot();

    const result = await createDedicatedWorkspace({ cwd: source, projectName: "Local Idea", rootPreference: root, rootSource: "flag" }, { runtimeHome });

    expect(result.ok).toBe(true);
    expect(result.writeOccurred).toBe(true);
    expect(path.basename(result.workspacePath)).toBe(`${result.slug}--${result.shortId}`);
    expect(result.shortId).toBe(deriveShortId(result.projectId));
    expect(fs.existsSync(path.join(result.workspacePath, ".bmad-runtime", "project-identity.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.workspacePath, ".bmad-runtime", "baseline-lock.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.workspacePath, "_bmad-output", "implementation-artifacts"))).toBe(true);
    expect(loadState(result.workspacePath).active).toBe(false);
    expect(result.evidencePath).toBeTruthy();
    expect(fs.existsSync(path.join(result.workspacePath, result.evidencePath!))).toBe(true);
    const registry = readRegistry(runtimeHome);
    expect(registry.projects).toHaveLength(1);
    expect(registry.projects[0]?.projectId).toBe(result.projectId);
    expect(registry.projects[0]?.knownRoots).toContain(result.workspacePath);
  });

  it("adds project-local Pi package settings to the dedicated workspace when package root is known", async () => {
    const source = makeRoot();
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const packageRoot = makeRoot("pi-bmad-package-root-");
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "pi-bmad-runtime" }), "utf8");

    const result = await createDedicatedWorkspace({ cwd: source, projectName: "Installable Idea", rootPreference: root, packageRoot }, { runtimeHome });

    expect(result.ok).toBe(true);
    expect(result.packageSettingsPath).toBe(".pi/settings.json");
    expect(result.packageSpec).toBe(path.relative(result.workspacePath, packageRoot));
    expect(result.touchedPaths).toContain(".pi/settings.json");
    const settings = JSON.parse(fs.readFileSync(path.join(result.workspacePath, ".pi", "settings.json"), "utf8")) as { packages: string[] };
    expect(settings.packages).toContain(path.relative(result.workspacePath, packageRoot));
  });

  it("blocks creating a dedicated workspace inside the source cwd", async () => {
    const source = makeRoot();

    const result = await createDedicatedWorkspace({ cwd: source, projectName: "Unsafe", rootPreference: source }, { runtimeHome: makeRoot() });

    expect(result.ok).toBe(false);
    expect(result.writeOccurred).toBe(false);
    expect(result.error).toContain("source cwd");
  });

  it("keeps the same folder when retryProjectId is provided after a partial failure", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const retryProjectId = "11111111-2222-4333-8444-555555555555";

    const first = await createDedicatedWorkspace({ cwd: makeRoot(), projectName: "Retry Me", rootPreference: root, retryProjectId }, {
      runtimeHome,
      hooks: { beforeReplace() { throw new Error("simulated registry failure"); } },
    });
    const secondLayout = buildDedicatedWorkspacePath({ projectName: "Retry Me", projectId: retryProjectId, rootPreference: root });

    expect(first.ok).toBe(false);
    expect(first.workspacePath).toBe(secondLayout.workspacePath);
    expect(path.basename(first.workspacePath!)).toBe(`retry-me--${deriveShortId(retryProjectId)}`);
  });

  it("returns recovery when registry write fails after local scaffold", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();

    const result = await createDedicatedWorkspace({ cwd: makeRoot(), projectName: "Partial Failure", rootPreference: root }, {
      runtimeHome,
      hooks: {
        beforeReplace() {
          throw new Error("simulated registry failure");
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.writeOccurred).toBe(true);
    expect(result.workspacePath).toBeTruthy();
    expect(fs.existsSync(getStateFile(result.workspacePath!))).toBe(true);
    expect(loadState(result.workspacePath!).active).toBe(false);
    expect(result.recoveryAction).toBeTruthy();
    expect(result.touchedPaths.length).toBeGreaterThan(0);
    expect(fs.existsSync(registryFile(runtimeHome))).toBe(false);
  });
});
