import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPathConfig } from "../extensions/bmad-runtime/paths.js";
import { ensureProjectRegistered } from "../extensions/bmad-runtime/project.js";
import { resolveActiveProject } from "../extensions/bmad-runtime/resolution.js";
import { writeRuntimeHandoff } from "../extensions/bmad-runtime/handoff.js";
import { buildContinuationBootstrapPrompt, buildStartMenu, buildStartProjectOptions, buildStartRouterPrompt, findLatestProjectHandoff, parseStartNewArgs, parseStartNewText, parseStartRouterReply } from "../extensions/bmad-runtime/start.js";
import { loadState, saveState } from "../extensions/bmad-runtime/state.js";

let tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-start-"));
  tempDirs.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
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

function seedReadyArtifacts(root: string): void {
  const files = ["prd.md", "ux-design-specification.md", "phase-2-grill-with-docs-2026-05-29.md", "architecture.md", "epics.md"];
  for (const file of files) writeFile(root, `_bmad-output/planning-artifacts/${file}`, `---\nstatus: complete\nworkflowType: test\n---\n# ${file}\n`);
  writeFile(root, "_bmad-output/planning-artifacts/implementation-readiness-report-2026-05-29.md", "---\nreadinessDecision: pass\n---\n# Report\n**Overall Status:** READY\n");
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("BMAD start surface", () => {
  it("parses explicit new-project arguments without accepting missing --root values", () => {
    expect(parseStartNewArgs(["Night", "Watch", "--root", "C:/work"]).projectName).toBe("Night Watch");
    expect(parseStartNewArgs(["Night", "Watch", "--root", "C:/work"]).rootPreference).toBe("C:/work");
    expect(parseStartNewArgs(["Night", "--root"]).error).toContain("--root");
    expect(parseStartNewText("Night Watch --root \"C:/Users/Danie/My Projects\"")).toEqual({
      projectName: "Night Watch",
      rootPreference: "C:/Users/Danie/My Projects",
    });
    expect(parseStartNewText("Night Watch --git-init")).toEqual({
      projectName: "Night Watch",
      localVersioning: "init",
    });
    expect(parseStartNewText("Night Watch --root \"C:/Users/Danie/My Projects\" --no-git-init")).toEqual({
      projectName: "Night Watch",
      rootPreference: "C:/Users/Danie/My Projects",
      localVersioning: "skip",
    });
    expect(parseStartNewText("Night Watch --root").error).toContain("--root");
  });

  it("maps conversational start replies to existing project, new project, or unknown", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const registered = await ensureProjectRegistered(root, { runtimeHome });
    const resolution = await resolveActiveProject(root, { runtimeHome });
    const options = buildStartProjectOptions(resolution, registered.registry.ok ? registered.registry.value.projects : []);

    expect(parseStartRouterReply("1", options).action).toBe("continue");
    expect(parseStartRouterReply(registered.identity.projectName, options).action).toBe("continue");
    expect(parseStartRouterReply(`${options.length + 1}`, options).action).toBe("new");
    expect(parseStartRouterReply("novo Guardinha", options)).toEqual({ action: "new", projectName: "Guardinha" });
    expect(parseStartRouterReply("999", options).action).toBe("unknown");

    const ambiguousOptions = [
      { index: 1, projectId: "one", displayName: "Guardinha Noturno" },
      { index: 2, projectId: "two", displayName: "Guardinha Diurno" },
    ];
    expect(parseStartRouterReply("Guardinha", ambiguousOptions).action).toBe("unknown");
    expect(parseStartRouterReply("Guardinha Diurno", ambiguousOptions).action).toBe("continue");
  });

  it("finds the latest compact handoff candidate from runtime or evidence folders", () => {
    const root = makeRoot();
    const cfg = loadPathConfig(root);
    const older = writeFile(root, ".bmad-runtime/handoff-old.md", "# Old\n");
    const latest = writeFile(cfg.output_folder, "evidence/agent-handoff-latest.md", "# Latest\n\nNext: continue story 3.3.\n");
    fs.utimesSync(older, new Date("2026-06-08T00:00:00.000Z"), new Date("2026-06-08T00:00:00.000Z"));
    fs.utimesSync(latest, new Date("2026-06-09T00:00:00.000Z"), new Date("2026-06-09T00:00:00.000Z"));

    const handoff = findLatestProjectHandoff(root);

    expect(handoff?.relativePath).toBe("_bmad-output/evidence/agent-handoff-latest.md");
    expect(handoff?.excerpt).toContain("continue story 3.3");
  });

  it("formats /bmad start as an explicit no-write decision menu", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(root, { runtimeHome });
    const state = saveState(root, { ...loadState(root), active: true, phase: "2-planning", currentWorkflow: "bmad-create-prd" });
    const resolution = await resolveActiveProject(root, { runtimeHome });
    const before = listFiles(root);

    const menu = buildStartMenu(root, resolution, state);

    expect(menu).toContain("# BMAD Start");
    expect(menu).toContain("Continue:");
    expect(menu).toContain("Start a new dedicated BMAD project workspace");
    expect(menu).toContain("should not need to memorize subcommands");
    expect(listFiles(root)).toEqual(before);
  });

  it("builds a conversational start router prompt for the Pi agent", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(root, { runtimeHome });
    const state = saveState(root, { ...loadState(root), active: true, phase: "1-analysis", currentWorkflow: "bmad-product-brief" });
    const resolution = await resolveActiveProject(root, { runtimeHome });

    const prompt = buildStartRouterPrompt(root, resolution, state);

    expect(prompt).toContain("/skill:bmad-runtime-for-pi start router");
    expect(prompt).toContain("Ask one concise question");
    expect(prompt).toContain("should not need to know internal subcommands");
    expect(prompt).toContain("Use the Pi agent and BMAD Runtime as the product model");
    for (const forbidden of ["Her" + "mes", "zico" + "-method"]) {
      expect(prompt).not.toContain(forbidden);
    }
  });

  it("builds a continuation bootstrap prompt anchored to project identity and latest handoff", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(root, { runtimeHome });
    const cfg = loadPathConfig(root);
    writeFile(cfg.output_folder, "evidence/session-handoff.md", "# Handoff\n\nResume PRD validation.\n");
    const state = saveState(root, { ...loadState(root), active: true, phase: "2-planning", currentWorkflow: "bmad-validate-prd" });
    const resolution = await resolveActiveProject(root, { runtimeHome });

    const prompt = buildContinuationBootstrapPrompt(root, resolution, state);

    expect(prompt).toContain("/skill:bmad-runtime-for-pi resume existing-project");
    expect(prompt).toContain("Current phase: 2-planning");
    expect(prompt).toContain("Current workflow: bmad-validate-prd");
    expect(prompt).toContain("session-handoff.md");
    expect(prompt).toContain("Resume PRD validation");
    expect(prompt).toContain("Do not mix this project");
    expect(prompt).toContain("task docs may be treated as ephemeral");
  });

  it("adds Phase 3 resume guidance from artifacts instead of chat memory", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(root, { runtimeHome });
    writeFile(root, "_bmad-output/planning-artifacts/architecture.md", "---\nstatus: complete\nworkflowType: test\n---\n# Architecture\n");
    const state = saveState(root, { ...loadState(root), active: true, mode: "autonomous", phase: "3-solutioning", currentWorkflow: "bmad-create-epics-and-stories" });
    const resolution = await resolveActiveProject(root, { runtimeHome });

    const prompt = buildContinuationBootstrapPrompt(root, resolution, state);

    expect(prompt).toContain("## Phase 3 Resume/Validate");
    expect(prompt).toContain("Current step: epics-stories");
    expect(prompt).toContain("Resume action: Run bmad-create-epics-and-stories");
    expect(prompt).toContain("_bmad-output/planning-artifacts/architecture.md");
    expect(prompt).toContain("runtime state as authoritative");
    for (const forbidden of ["Her" + "mes", "zico" + "-method"]) {
      expect(prompt).not.toContain(forbidden);
    }
  });

  it("adds Phase 4 resume guidance from sprint status instead of chat memory", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(root, { runtimeHome });
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
    const state = saveState(root, { ...loadState(root), active: true, mode: "autonomous", phase: "4-implementation", currentWorkflow: "bmad-create-story", currentStory: "4.3" });
    const resolution = await resolveActiveProject(root, { runtimeHome });

    const prompt = buildContinuationBootstrapPrompt(root, resolution, state);

    expect(prompt).toContain("## Phase 4 Resume/Validate");
    expect(prompt).toContain("Story ID: 4-3-phase-4-state-resume-validate-para-story-execution");
    expect(prompt).toContain("Checkpoint: create-story");
    expect(prompt).toContain("Resume action: Create story context");
    expect(prompt).toContain("runtime state as authoritative");
  });

  it("uses start/resume as the Phase 4 automation driver and carries readiness blockers", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(root, { runtimeHome });
    writeFile(root, "_bmad-output/implementation-artifacts/sprint-status.yaml", [
      "generated: 2026-06-09T00:00:00Z",
      "last_updated: 2026-06-09T00:00:00Z",
      "project: Test",
      "development_status:",
      "  epic-4: in-progress",
      "  4-7-automacao-phase-3-4-sem-comando-separado: backlog",
      "  epic-4-retrospective: optional",
      "",
    ].join("\n"));
    const state = saveState(root, { ...loadState(root), active: true, mode: "autonomous", phase: "4-implementation", currentWorkflow: "bmad-create-story", currentStory: "4.7" });
    const resolution = await resolveActiveProject(root, { runtimeHome });

    const prompt = buildContinuationBootstrapPrompt(root, resolution, state);

    expect(prompt).toContain("## Phase 4 Automatic Next Step");
    expect(prompt).toContain("BMAD automatic next step: blocked");
    expect(prompt).toContain("readiness pass or scoped waiver is required");
    expect(prompt).toContain("this resume bootstrap are the normal automation driver");
    expect(prompt).not.toContain("/bmad autopilot");
    expect(prompt).not.toContain("/bmad autonomous");
  });

  it("uses the same start/resume control plane to choose the next automatic Phase 4 action when readiness passes", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(root, { runtimeHome });
    seedReadyArtifacts(root);
    writeFile(root, "_bmad-output/implementation-artifacts/sprint-status.yaml", [
      "generated: 2026-06-09T00:00:00Z",
      "last_updated: 2026-06-09T00:00:00Z",
      "project: Test",
      "development_status:",
      "  epic-4: in-progress",
      "  4-7-automacao-phase-3-4-sem-comando-separado: backlog",
      "  epic-4-retrospective: optional",
      "",
    ].join("\n"));
    const state = saveState(root, { ...loadState(root), active: true, mode: "autonomous", phase: "4-implementation", currentWorkflow: "bmad-create-story", currentStory: "4.7" });
    const resolution = await resolveActiveProject(root, { runtimeHome });

    const prompt = buildContinuationBootstrapPrompt(root, resolution, state);

    expect(prompt).toContain("BMAD automatic next step: create-story");
    expect(prompt).toContain("Action: create-story");
    expect(prompt).toContain("Execute the loop, not just a recommendation");
    expect(prompt).not.toContain("/bmad autopilot");
    expect(prompt).not.toContain("/bmad autonomous");
  });

  it("routes completed Phase 4 resume toward ready-for-use instead of another execution plan", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(root, { runtimeHome });
    seedReadyArtifacts(root);
    writeFile(root, "_bmad-output/implementation-artifacts/sprint-status.yaml", [
      "generated: 2026-06-09T00:00:00Z",
      "last_updated: 2026-06-09T00:00:00Z",
      "project: Test",
      "development_status:",
      "  epic-4: done",
      "  4-7-automacao-phase-3-4-sem-comando-separado: done",
      "  epic-4-retrospective: optional",
      "",
    ].join("\n"));
    const state = saveState(root, { ...loadState(root), active: true, mode: "autonomous", phase: "4-implementation", currentWorkflow: "bmad-code-review", currentStory: "4.7" });
    const resolution = await resolveActiveProject(root, { runtimeHome });

    const prompt = buildContinuationBootstrapPrompt(root, resolution, state);

    expect(prompt).toContain("## Phase 4 Complete");
    expect(prompt).toContain("/bmad phase 5-ready-for-use");
    expect(prompt).toContain("If Phase 5, do not resume Phase 4 story automation");
    expect(prompt).not.toContain("Execute the loop, not just a recommendation");
  });

  it("writes a canonical latest handoff that start bootstrap can discover", () => {
    const root = makeRoot();
    const state = saveState(root, { ...loadState(root), active: true, phase: "4-implementation", currentWorkflow: "bmad-create-story", currentStory: "3.3" });

    const result = writeRuntimeHandoff(root, {
      reason: "test",
      state,
      nextStep: "Create Story 3.3.",
      messages: [{ role: "assistant", content: "Story 3.2 is done. Next: create Story 3.3." }],
    });

    expect(result.relativePath).toBe(".bmad-runtime/handoffs/latest-handoff.md");
    const text = fs.readFileSync(result.absolutePath, "utf8");
    expect(text).toContain("Current workflow: bmad-create-story");
    expect(text).toContain("Create Story 3.3.");
    expect(text).toContain("Story 3.2 is done");
    expect(findLatestProjectHandoff(root)?.relativePath).toBe(result.relativePath);
  });
});
