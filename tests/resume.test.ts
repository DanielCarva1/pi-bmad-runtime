import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildResumeProjectResolution, formatResumeProjectResult, resolveResumeProject } from "../extensions/bmad-runtime/resume.js";
import { REGISTRY_SCHEMA_VERSION, type ProjectRegistryRecord } from "../extensions/bmad-runtime/registry.js";
import { createDefaultState, getStateFile, saveState } from "../extensions/bmad-runtime/state.js";

let tempDirs: string[] = [];

function makeRoot(prefix = "pi-bmad-resume-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function registryFile(runtimeHome: string): string {
  return path.join(runtimeHome, "projects.json");
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${path.relative(root, full).replaceAll(path.sep, "/")}:${fs.readFileSync(full, "utf8")}`);
    }
  };
  walk(root);
  return out.sort();
}

function record(root: string, overrides: Partial<ProjectRegistryRecord> = {}): ProjectRegistryRecord {
  return {
    projectId: "project-alpha",
    displayName: "Project Alpha",
    historicalAliases: [],
    knownRoots: [root],
    artifactRoot: path.join(root, "_bmad-output"),
    runtimeStatePath: getStateFile(root),
    pathAliases: [root],
    phase: "4-implementation",
    status: "story-6.3-in-progress",
    currentWorkflow: "bmad-dev-story",
    currentStory: "6.3",
    readinessState: "pass",
    lastWorkflow: "bmad-create-story",
    lastSeenAt: "2026-06-09T17:20:00.000Z",
    ...overrides,
  };
}

function writeRegistry(runtimeHome: string, projects: ProjectRegistryRecord[]): void {
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.writeFileSync(
    registryFile(runtimeHome),
    `${JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, projects, updatedAt: "2026-06-09T17:20:00.000Z" }, null, 2)}\n`,
    "utf8",
  );
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("runtime resume project resolution", () => {
  it("resolves a project by alias from another cwd and builds canonical resume output", async () => {
    const projectRoot = makeRoot();
    const runtimeHome = makeRoot();
    const otherCwd = makeRoot();
    const project = record(projectRoot, {
      projectId: "builder-id",
      displayName: "Pi BMAD Builder",
      historicalAliases: ["pi-bmad-builder"],
    });
    saveState(projectRoot, {
      ...createDefaultState(),
      active: false,
      mode: "autonomous",
      phase: "4-implementation",
      currentWorkflow: "bmad-dev-story",
      currentStory: "6.3",
    });
    writeRegistry(runtimeHome, [project]);

    const result = await resolveResumeProject("pi-bmad-builder", { registryOptions: { runtimeHome } });
    const resolution = buildResumeProjectResolution(result);
    const formatted = formatResumeProjectResult(result, { writeOccurred: true, handoffPath: ".bmad-runtime/handoffs/latest-handoff.md" });

    expect(result.status).toBe("ready");
    expect(result.workspacePath).toBe(projectRoot);
    expect(result.reason).toContain("without using current cwd");
    expect(result.workspacePath).not.toBe(otherCwd);
    expect(resolution.confidence).toBe("unique_confident");
    expect(resolution.canonicalPaths.cwd).toBe(projectRoot);
    expect(resolution.selectedProject?.projectId).toBe("builder-id");
    expect(formatted).toContain("Write occurred: true");
    expect(formatted).toContain("- Next step: Continue bmad-dev-story for story 6.3.");
    expect(formatted).toContain(`- Project Workspace: ${projectRoot}`);
    expect(formatted).toContain(`- Runtime state: ${getStateFile(projectRoot)}`);
    expect(formatted).toContain(`- Registry: ${registryFile(runtimeHome)}`);
  });

  it("blocks ambiguous names with a picker before any write", async () => {
    const runtimeHome = makeRoot();
    const firstRoot = makeRoot();
    const secondRoot = makeRoot();
    saveState(firstRoot, { ...createDefaultState(), active: true });
    saveState(secondRoot, { ...createDefaultState(), active: true });
    writeRegistry(runtimeHome, [
      record(firstRoot, { projectId: "guardinha-app", displayName: "Guardinha App" }),
      record(secondRoot, { projectId: "guardinha-api", displayName: "Guardinha API" }),
    ]);
    const beforeRegistry = listFiles(runtimeHome);
    const beforeFirst = listFiles(firstRoot);
    const beforeSecond = listFiles(secondRoot);

    const result = await resolveResumeProject("Guardinha", { registryOptions: { runtimeHome } });
    const formatted = formatResumeProjectResult(result);

    expect(result.status).toBe("ambiguous");
    expect(result.writeOccurred).toBe(false);
    expect(result.matches.map((project) => project.projectId).sort()).toEqual(["guardinha-api", "guardinha-app"]);
    expect(formatted).toContain("## Resume Picker");
    expect(formatted).toContain("No project state, registry, artifact, or workspace write occurred.");
    expect(listFiles(runtimeHome)).toEqual(beforeRegistry);
    expect(listFiles(firstRoot)).toEqual(beforeFirst);
    expect(listFiles(secondRoot)).toEqual(beforeSecond);
  });

  it("blocks missing runtime state instead of silently creating a new project state", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    writeRegistry(runtimeHome, [record(root, { projectId: "missing-state", displayName: "Missing State" })]);

    const result = await resolveResumeProject("missing-state", { registryOptions: { runtimeHome } });
    const formatted = formatResumeProjectResult(result);

    expect(result.status).toBe("blocked");
    expect(result.writeOccurred).toBe(false);
    expect(result.recoveryAction).toBe("repair-project-runtime-state-before-resume");
    expect(formatted).toContain("runtime state is missing");
    expect(fs.existsSync(getStateFile(root))).toBe(false);
  });
});
