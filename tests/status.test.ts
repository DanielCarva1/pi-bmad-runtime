import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProjectInitialized } from "../extensions/bmad-runtime/project.js";
import { REGISTRY_SCHEMA_VERSION, type ProjectRegistryRecord } from "../extensions/bmad-runtime/registry.js";
import { buildRuntimeStatusReport, formatRuntimeStatusReport } from "../extensions/bmad-runtime/status.js";
import { createDefaultState, getStateFile, saveState } from "../extensions/bmad-runtime/state.js";

let tempDirs: string[] = [];

function makeRoot(prefix = "pi-bmad-status-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
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
    projectId: "status-project",
    displayName: "Status Project",
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
  fs.writeFileSync(registryFile(runtimeHome), `${JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, projects }, null, 2)}\n`, "utf8");
}

function makeGitRepo(root: string, remote: string): void {
  const git = path.join(root, ".git");
  fs.mkdirSync(path.join(git, "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(git, "config"), `[remote "origin"]\n\turl = ${remote}\n`, "utf8");
  fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n", "utf8");
  fs.writeFileSync(path.join(git, "refs", "heads", "main"), "0123456789abcdef0123456789abcdef01234567\n", "utf8");
}

function fingerprint(remote: string): string {
  return crypto.createHash("sha256").update(remote).digest("hex");
}

function seedReadyArtifacts(root: string): void {
  const files = ["prd.md", "ux-design-specification.md", "phase-2-grill-with-docs-2026-05-29.md", "architecture.md", "epics.md"];
  for (const file of files) writeFile(root, `_bmad-output/planning-artifacts/${file}`, `---\nstatus: complete\nworkflowType: test\n---\n# ${file}\n`);
  writeFile(root, "_bmad-output/planning-artifacts/implementation-readiness-report-2026-05-29.md", "---\nreadinessDecision: pass\n---\n# Report\n**Overall Status:** READY\n");
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("runtime status report", () => {
  it("formats active project, runtime state, readiness, next step, confidence and canonical paths", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(root);
    seedReadyArtifacts(root);
    saveState(root, { ...createDefaultState(), active: true, mode: "autonomous", track: "bmad-method", phase: "4-implementation", currentWorkflow: "bmad-dev-story", currentStory: "2.6" });
    writeRegistry(runtimeHome, [record(root, { projectId: initialized.identity.projectId, displayName: initialized.identity.projectName })]);

    const report = await buildRuntimeStatusReport(root, { registryOptions: { runtimeHome } });
    const formatted = formatRuntimeStatusReport(report);

    expect(report.resolution.confidence).toBe("unique_confident");
    expect(report.writeOccurred).toBe(false);
    expect(formatted).toContain("## Active Project");
    expect(formatted).toContain(`Project: ${initialized.identity.projectName} (${initialized.identity.projectId})`);
    expect(formatted).toContain("Confidence: unique_confident");
    expect(formatted).toContain("## Operational Summary");
    expect(formatted).toContain("- Phase: 4-implementation");
    expect(formatted).toContain("- Current workflow: bmad-dev-story");
    expect(formatted).toContain("- Current story: 2.6");
    expect(formatted).toContain("- Readiness decision: pass");
    expect(formatted).toContain("- Readiness state: pass");
    expect(formatted).toContain("currentWorkflow: bmad-dev-story");
    expect(formatted).toContain("currentStory: 2.6");
    expect(formatted).toContain("Implementation readiness gate:");
    expect(formatted).toContain("Artifact cleanup policy:");
    expect(formatted).toContain("Delete/archive is allowed only after result, changed files, checks, evidence reference and next status are captured.");
    expect(formatted).toContain("Readiness blockers: none");
    expect(formatted).toContain("Readiness waiver: none");
    expect(formatted).toContain("Next safe action:");
    expect(formatted).toContain("Project Workspace:");
    expect(formatted).toContain("Runtime State:");
    expect(formatted).toContain("Registry:");
    expect(formatted).toContain("Status duration:");
  });

  it("does not mutate project workspace or registry while building status", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(root);
    saveState(root, { ...createDefaultState(), active: true, mode: "autonomous", track: "bmad-method", phase: "4-implementation" });
    writeRegistry(runtimeHome, [record(root, { projectId: initialized.identity.projectId, displayName: initialized.identity.projectName })]);
    const beforeWorkspace = listFiles(root);
    const beforeRegistry = listFiles(runtimeHome);

    await buildRuntimeStatusReport(root, { registryOptions: { runtimeHome } });

    expect(listFiles(root)).toEqual(beforeWorkspace);
    expect(listFiles(runtimeHome)).toEqual(beforeRegistry);
  });

  it("reports ready-for-use without Phase 4 automation", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(root);
    saveState(root, { ...createDefaultState(), active: true, mode: "paused", track: "bmad-method", phase: "5-ready-for-use" });
    writeRegistry(runtimeHome, [record(root, { projectId: initialized.identity.projectId, displayName: initialized.identity.projectName })]);

    const report = await buildRuntimeStatusReport(root, { registryOptions: { runtimeHome } });
    const formatted = formatRuntimeStatusReport(report);

    expect(report.phase4).toBeUndefined();
    expect(formatted).toContain("- Phase: 5-ready-for-use");
    expect(formatted).toContain("- Next step: ready-for-use: monitor, support, publish/install smoke, or start a new version/story explicitly");
    expect(formatted).not.toContain("## Phase 4 Resume/Validate");
    expect(formatted).not.toContain("Phase 4 automatic");
  });

  it("stays read-only for blocked status when the registry is missing", async () => {
    const root = makeRoot();
    const runtimeHome = path.join(makeRoot(), "missing-runtime-home");
    const beforeWorkspace = listFiles(root);

    const report = await buildRuntimeStatusReport(root, { registryOptions: { runtimeHome } });

    expect(report.resolution.confidence).toBe("blocked");
    expect(report.writeOccurred).toBe(false);
    expect(formatRuntimeStatusReport(report)).toContain("Confidence: blocked");
    expect(formatRuntimeStatusReport(report)).toContain("- Readiness decision: blocked");
    expect(formatRuntimeStatusReport(report)).toContain("- Readiness state: blocked");
    expect(listFiles(root)).toEqual(beforeWorkspace);
    expect(fs.existsSync(runtimeHome)).toBe(false);
  });

  it("shows waived readiness as an exception instead of a normal pass", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(root);
    for (const file of ["prd.md", "ux-design-specification.md", "phase-2-grill-with-docs-2026-05-29.md", "architecture.md", "epics.md"]) {
      writeFile(root, `_bmad-output/planning-artifacts/${file}`, `---\nstatus: complete\nworkflowType: test\n---\n# ${file}\n`);
    }
    writeFile(root, "_bmad-output/planning-artifacts/implementation-readiness-report-2026-05-29.md", "---\nreadinessDecision: waived\n---\n# Waived readiness\n");
    saveState(root, { ...createDefaultState(), active: true, mode: "autonomous", track: "bmad-method", phase: "4-implementation", currentWorkflow: "bmad-create-story", currentStory: "6.1" });
    writeRegistry(runtimeHome, [record(root, { projectId: initialized.identity.projectId, displayName: initialized.identity.projectName })]);

    const formatted = formatRuntimeStatusReport(await buildRuntimeStatusReport(root, { registryOptions: { runtimeHome } }));

    expect(formatted).toContain("- Readiness decision: waived");
    expect(formatted).toContain("- Readiness state: waived (exception)");
    expect(formatted).toContain("Readiness waiver: Recorded readiness waiver detected in report.");
    expect(formatted).not.toContain("- Readiness state: pass");
  });

  it("shows the name-first picker when status resolution is ambiguous", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const remote = "https://example.com/status/runtime.git";
    makeGitRepo(root, remote);
    ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [
      record(path.join(root, "a"), { projectId: "status-a", displayName: "Status A", gitEvidence: { remoteUrlFingerprint: fingerprint(remote) } }),
      record(path.join(root, "b"), { projectId: "status-b", displayName: "Status B", gitEvidence: { remoteUrlFingerprint: fingerprint(remote) } }),
    ]);

    const report = await buildRuntimeStatusReport(root, { registryOptions: { runtimeHome } });
    const formatted = formatRuntimeStatusReport(report);

    expect(report.resolution.confidence).toBe("ambiguous");
    expect(formatted).toContain("## Name-First Project Picker");
    expect(formatted).toContain("Details: /bmad start details <number|name|projectId>");
    expect(formatted).toContain("Selection remains conversational through /bmad-start or /bmad start");
    expect(formatted).not.toContain("read-only in this story");
    expect(formatted).not.toContain("remote fingerprint:");
  });

  it("handles a 100 project registry within the status performance contract", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(root);
    const projects = [record(root, { projectId: initialized.identity.projectId, displayName: initialized.identity.projectName })];
    for (let i = 1; i < 100; i += 1) {
      const otherRoot = path.join(runtimeHome, `other-${i}`);
      projects.push(record(otherRoot, { projectId: `other-${i}`, displayName: `Other ${i}`, knownRoots: [otherRoot], pathAliases: [otherRoot] }));
    }
    writeRegistry(runtimeHome, projects);

    const report = await buildRuntimeStatusReport(root, { registryOptions: { runtimeHome } });

    expect(formatRuntimeStatusReport(report)).toContain("Status duration:");
    if (report.durationMs > 2000) expect(formatRuntimeStatusReport(report)).toContain("Performance note:");
  });

  it("explains status delay when the performance threshold is exceeded", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [record(root)]);
    const ticks = [0, 2501];
    const report = await buildRuntimeStatusReport(root, { registryOptions: { runtimeHome }, now: () => ticks.shift() ?? 2501 });

    expect(report.durationMs).toBe(2501);
    expect(formatRuntimeStatusReport(report)).toContain("Performance note: status exceeded 2000ms");
    expect(formatRuntimeStatusReport(report)).toContain("writeOccurred=false");
  });

  it("includes a compact Phase 3 resume and validation card from persisted artifacts", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(root);
    seedReadyArtifacts(root);
    saveState(root, { ...createDefaultState(), active: true, mode: "autonomous", track: "bmad-method", phase: "3-solutioning", currentWorkflow: "bmad-check-implementation-readiness" });
    writeRegistry(runtimeHome, [record(root, { projectId: initialized.identity.projectId, displayName: initialized.identity.projectName })]);

    const report = await buildRuntimeStatusReport(root, { registryOptions: { runtimeHome } });
    const formatted = formatRuntimeStatusReport(report);

    expect(report.phase3?.currentStep).toBe("ready-for-phase-4");
    expect(report.phase3Validation?.ok).toBe(true);
    expect(formatted).toContain("## Phase 3 Resume/Validate");
    expect(formatted).toContain("Current step: ready-for-phase-4");
    expect(formatted).toContain("Resume action: Transition to Phase 4 implementation from persisted readiness evidence.");
    expect(formatted).toContain("Validation: ok");
  });

  it("includes a compact Phase 4 resume and validation card from sprint status", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(root);
    writeFile(root, "_bmad-output/implementation-artifacts/sprint-status.yaml", [
      "generated: 2026-06-09T00:00:00Z",
      "last_updated: 2026-06-09T00:00:00Z",
      "project: Test",
      "development_status:",
      "  epic-4: in-progress",
      "  4-3-phase-4-state-resume-validate-para-story-execution: backlog",
      "  epic-4-retrospective: optional",
      "",
    ].join("\n"));
    saveState(root, { ...createDefaultState(), active: true, mode: "autonomous", track: "bmad-method", phase: "4-implementation", currentWorkflow: "bmad-create-story", currentStory: "4.3" });
    writeRegistry(runtimeHome, [record(root, { projectId: initialized.identity.projectId, displayName: initialized.identity.projectName })]);

    const report = await buildRuntimeStatusReport(root, { registryOptions: { runtimeHome } });
    const formatted = formatRuntimeStatusReport(report);

    expect(report.phase4?.checkpoint).toBe("create-story");
    expect(report.phase4Validation?.ok).toBe(true);
    expect(formatted).toContain("## Phase 4 Resume/Validate");
    expect(formatted).toContain("Story ID: 4-3-phase-4-state-resume-validate-para-story-execution");
    expect(formatted).toContain("Checkpoint: create-story");
    expect(formatted).toContain("Resume action: Create story context");
  });
});
