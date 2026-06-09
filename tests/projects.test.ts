import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRuntimeProjectsReport, formatRuntimeProjectsReport, parseProjectsArgs } from "../extensions/bmad-runtime/projects.js";
import { REGISTRY_SCHEMA_VERSION, type ProjectRegistryRecord } from "../extensions/bmad-runtime/registry.js";

let tempDirs: string[] = [];

function makeRoot(prefix = "pi-bmad-projects-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
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

function registryFile(runtimeHome: string): string {
  return path.join(runtimeHome, "projects.json");
}

function record(root: string, overrides: Partial<ProjectRegistryRecord> = {}): ProjectRegistryRecord {
  return {
    projectId: "project-alpha",
    displayName: "Project Alpha",
    historicalAliases: [],
    knownRoots: [root],
    artifactRoot: path.join(root, "_bmad-output"),
    runtimeStatePath: path.join(root, ".bmad-runtime", "state.json"),
    pathAliases: [root],
    phase: "4-implementation",
    status: "story-1.1-done",
    currentWorkflow: "bmad-create-story",
    currentStory: "1.2",
    readinessState: "pass",
    lastWorkflow: "bmad-code-review",
    lastSeenAt: "2026-06-09T12:00:00.000Z",
    ...overrides,
  };
}

function writeRegistry(runtimeHome: string, projects: ProjectRegistryRecord[]): void {
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.writeFileSync(
    registryFile(runtimeHome),
    `${JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, projects, updatedAt: "2026-06-09T12:10:00.000Z" }, null, 2)}\n`,
    "utf8",
  );
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("runtime projects report", () => {
  it("lists registered projects read-only with status, roots and last activity", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const oldRoot = path.join(runtimeHome, "old");
    writeRegistry(runtimeHome, [
      record(oldRoot, { projectId: "old-project", displayName: "Old Project", knownRoots: [oldRoot], pathAliases: [oldRoot], lastSeenAt: "2026-06-01T00:00:00.000Z" }),
      record(root, { projectId: "night-guard", displayName: "Guardinha Noturno", status: "story-3.2-in-progress", knownRoots: [root, path.join(root, "worktree")], lastSeenAt: "2026-06-09T13:00:00.000Z" }),
    ]);
    const ticks = [0, 5];

    const report = await buildRuntimeProjectsReport(root, { registryOptions: { runtimeHome }, now: () => ticks.shift() ?? 5 });
    const formatted = formatRuntimeProjectsReport(report);

    expect(report.writeOccurred).toBe(false);
    expect(report.projects.map((project) => project.projectId)).toEqual(["night-guard", "old-project"]);
    expect(formatted).toContain("# BMAD Projects");
    expect(formatted).toContain("Project count: 2");
    expect(formatted).toContain("Showing: 2/2");
    expect(formatted).toContain("1. Guardinha Noturno - status: 4-implementation / story-3.2-in-progress");
    expect(formatted).toContain(`roots: ${root}; ${path.join(root, "worktree")}`);
    expect(formatted).toContain("last seen: 2026-06-09T13:00:00.000Z");
    expect(formatted).toContain("Selection/creation remains conversational through `/bmad-start` or `/bmad start`.");
    expect(formatted).not.toContain("## Project Details");
  });

  it("shows project details on demand by stable id, name or alias", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    writeRegistry(runtimeHome, [
      record(root, {
        projectId: "builder-id",
        displayName: "Pi BMAD Builder",
        historicalAliases: ["pi-bmad-builder"],
        activeVersion: "v0.2.0",
        gitEvidence: {
          worktreePath: root,
          branch: "main",
          commit: "0123456789abcdef0123456789abcdef01234567",
          remoteUrlFingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        targetRepos: [{ role: "runtime-package", path: path.join(root, "runtime") }],
      }),
    ]);

    const byId = formatRuntimeProjectsReport(await buildRuntimeProjectsReport(root, { registryOptions: { runtimeHome }, detailSelector: "builder-id" }));
    const byName = await buildRuntimeProjectsReport(root, { registryOptions: { runtimeHome }, detailSelector: "Pi BMAD Builder" });
    const byAlias = await buildRuntimeProjectsReport(root, { registryOptions: { runtimeHome }, detailSelector: "pi-bmad-builder" });

    expect(byName.selectedProject?.projectId).toBe("builder-id");
    expect(byAlias.selectedProject?.projectId).toBe("builder-id");
    expect(byId).toContain("## Project Details");
    expect(byId).toContain("- Stable ID: builder-id");
    expect(byId).toContain("- Historical aliases: pi-bmad-builder");
    expect(byId).toContain(`- Artifact root: ${path.join(root, "_bmad-output")}`);
    expect(byId).toContain("- Current workflow: bmad-create-story");
    expect(byId).toContain("- Last workflow: bmad-code-review");
    expect(byId).toContain("- Readiness: pass");
    expect(byId).toContain("- Remote fingerprint: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(byId).toContain("- runtime-package:");
  });

  it("does not mutate workspace or registry while listing projects", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    writeRegistry(runtimeHome, [record(root)]);
    const beforeWorkspace = listFiles(root);
    const beforeRegistry = listFiles(runtimeHome);

    await buildRuntimeProjectsReport(root, { registryOptions: { runtimeHome }, detailSelector: "1" });

    expect(listFiles(root)).toEqual(beforeWorkspace);
    expect(listFiles(runtimeHome)).toEqual(beforeRegistry);
  });

  it("reports missing registry without creating Runtime Home", async () => {
    const root = makeRoot();
    const runtimeHome = path.join(makeRoot(), "missing-runtime-home");

    const report = await buildRuntimeProjectsReport(root, { registryOptions: { runtimeHome } });
    const formatted = formatRuntimeProjectsReport(report);

    expect(report.registryError?.code).toBe("REGISTRY_NOT_FOUND");
    expect(report.writeOccurred).toBe(false);
    expect(formatted).toContain("## Registry Unavailable");
    expect(formatted).toContain("Write occurred: false");
    expect(fs.existsSync(runtimeHome)).toBe(false);
  });

  it("emits performance and large registry notes for many projects", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const projects = Array.from({ length: 100 }, (_, index) => {
      const projectRoot = path.join(runtimeHome, `project-${index}`);
      return record(projectRoot, {
        projectId: `project-${index}`,
        displayName: `Project ${index}`,
        knownRoots: [projectRoot],
        pathAliases: [projectRoot],
        lastSeenAt: `2026-06-09T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
      });
    });
    writeRegistry(runtimeHome, projects);
    const ticks = [0, 2501];

    const formatted = formatRuntimeProjectsReport(await buildRuntimeProjectsReport(root, {
      registryOptions: { runtimeHome },
      now: () => ticks.shift() ?? 2501,
    }));

    expect(formatted).toContain("Performance note: projects exceeded 2000ms");
    expect(formatted).toContain("Large registry note: listed 100 projects from metadata only");
    expect(formatted).toContain("Showing: 50/100");
    expect(formatted).toContain("... 50 more projects hidden to keep context compact");
  });

  it("parses details arguments without introducing extra project selection commands", () => {
    expect(parseProjectsArgs(["details", "1"])).toEqual({ detailSelector: "1" });
    expect(parseProjectsArgs(["show", "Pi", "BMAD"])).toEqual({ detailSelector: "Pi BMAD" });
    expect(parseProjectsArgs(["Pi", "BMAD"])).toEqual({ detailSelector: "Pi BMAD" });
    expect(parseProjectsArgs([])).toEqual({});
  });
});
