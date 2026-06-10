import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import bmadRuntimeExtension from "../extensions/bmad-runtime/index.js";
import { scanPackageAdapters } from "../extensions/bmad-runtime/adapters.js";
import { buildPhase4AutomationExecutionPlan, recommendPhase4Automation } from "../extensions/bmad-runtime/phase4-automation.js";
import { describeRuntimeBoundaries, formatRuntimeBoundaries } from "../extensions/bmad-runtime/boundaries.js";
import { scanArtifactRegistry } from "../extensions/bmad-runtime/artifacts.js";
import { validateRuntimeConfig } from "../extensions/bmad-runtime/config.js";
import { createDelegationContract, detectDelegationCapability, runDelegationContract, validateDelegationContract, type SubagentsServiceLike } from "../extensions/bmad-runtime/delegation.js";
import { evaluateReadinessGate } from "../extensions/bmad-runtime/readiness.js";
import { determineRecoveryPoint } from "../extensions/bmad-runtime/recovery.js";
import { parseReviewFindings, reviewBlocksDone, runParallelReviewDelegation, synthesizeReviewFindings } from "../extensions/bmad-runtime/review.js";
import { summarizeLedger } from "../extensions/bmad-runtime/ledger.js";
import { loadPathConfig } from "../extensions/bmad-runtime/paths.js";
import { ensureProjectInitialized } from "../extensions/bmad-runtime/project.js";
import { parseSprintStatusText } from "../extensions/bmad-runtime/sprint.js";
import { createDefaultState, saveState } from "../extensions/bmad-runtime/state.js";
import { formatTransitionPrompt } from "../extensions/bmad-runtime/transition.js";
import { commandHelp, formatRuntimeHelp } from "../extensions/bmad-runtime/ui.js";

let tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-surface-"));
  tempDirs.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("runtime surface helpers", () => {
  it("does not register a separate public automation command", () => {
    const commands = new Map<string, { getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] }>();
    bmadRuntimeExtension({
      registerCommand(name: string, spec: { getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] }) {
        commands.set(name, spec);
      },
      on() { /* noop */ },
    } as any);

    const bmad = commands.get("bmad");
    const completions = bmad?.getArgumentCompletions?.("").map((item) => item.value) ?? [];

    expect(commands.has("bmad-start")).toBe(true);
    expect(completions).toContain("start");
    expect(completions).toContain("projects");
    expect(completions).toContain("resume");
    expect(completions).not.toContain("autonomous");
    expect(completions).not.toContain("autopilot");
  });

  it("skips duplicate command registration when another runtime copy already loaded", () => {
    const commands = new Map<string, unknown>();
    bmadRuntimeExtension({
      getCommands() {
        return [{
          name: "bmad-start",
          source: "extension",
          sourceInfo: {
            path: path.join(process.cwd(), "extensions", "bmad-runtime", "index.ts"),
            source: "git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.2",
            scope: "project",
            origin: "package",
            baseDir: process.cwd(),
          },
        }];
      },
      registerCommand(name: string, spec: unknown) {
        commands.set(name, spec);
      },
      on() { /* noop */ },
    } as any);

    expect(commands.size).toBe(0);
  });

  it("uses a process-level guard when duplicate runtime copies load before command discovery is populated", () => {
    const key = Symbol.for("pi-bmad-runtime.extension-registered");
    delete (globalThis as Record<symbol, boolean | undefined>)[key];
    try {
      const first = new Map<string, unknown>();
      const second = new Map<string, unknown>();
      const makeApi = (commands: Map<string, unknown>) => ({
        getCommands() {
          return [];
        },
        registerCommand(name: string, spec: unknown) {
          commands.set(name, spec);
        },
        on() { /* noop */ },
      });

      bmadRuntimeExtension(makeApi(first) as any);
      bmadRuntimeExtension(makeApi(second) as any);

      expect(first.has("bmad-start")).toBe(true);
      expect(second.size).toBe(0);
    } finally {
      delete (globalThis as Record<symbol, boolean | undefined>)[key];
    }
  });

  it("launches Phase 4 workflow fresh without mechanical confirmation", async () => {
    const root = makeRoot();
    saveState(root, { ...createDefaultState(), active: true, mode: "autonomous", phase: "4-implementation", track: "bmad-method", currentStory: "5.2" });
    const commands = new Map<string, { handler?: (rawArgs: string, ctx: any) => Promise<void> }>();
    bmadRuntimeExtension({
      registerCommand(name: string, spec: { handler?: (rawArgs: string, ctx: any) => Promise<void> }) {
        commands.set(name, spec);
      },
      on() { /* noop */ },
      appendEntry() { /* noop */ },
      sendMessage() { /* noop */ },
      setSessionName() { /* noop */ },
      sendUserMessage() { /* noop */ },
    } as any);

    let confirmCalls = 0;
    let freshPrompt = "";
    await commands.get("bmad")?.handler?.("run bmad-dev-story 5-2-prompt-policy-para-blockers-reais-e-acoes-de-alto-risco", {
      cwd: root,
      hasUI: true,
      sessionManager: { getSessionFile: () => "parent-session.json" },
      ui: {
        notify() { /* noop */ },
        async confirm() {
          confirmCalls += 1;
          return false;
        },
        setStatus() { /* noop */ },
        theme: { fg: (_kind: string, text: string) => text },
      },
      async newSession(options: { withSession: (nextCtx: { sendUserMessage: (prompt: string) => Promise<void> }) => Promise<void> }) {
        await options.withSession({
          async sendUserMessage(prompt: string) {
            freshPrompt = prompt;
          },
        });
      },
    });

    expect(confirmCalls).toBe(0);
    expect(freshPrompt).toContain("/skill:bmad-dev-story 5-2-prompt-policy-para-blockers-reais-e-acoes-de-alto-risco");
  });

  it("describes runtime boundaries with responsibilities and write policies", () => {
    const root = makeRoot();
    const runtimeHome = path.join(makeRoot(), "runtime-home");
    const targetCodeRepo = path.join(makeRoot(), "target-code-repo");

    const boundaries = describeRuntimeBoundaries(root, {
      packageRoot: process.cwd(),
      runtimeHome,
      targetCodeRepo,
    });
    const labels = boundaries.map((boundary) => boundary.label);
    expect(labels).toEqual([
      "Runtime Package",
      "Runtime Home",
      "Project Workspace",
      "Target Code Repo",
    ]);
    expect(boundaries.find((boundary) => boundary.label === "Runtime Home")?.path).toBe(runtimeHome);
    expect(boundaries.find((boundary) => boundary.label === "Project Workspace")?.path).toBe(root);
    expect(formatRuntimeBoundaries(boundaries, root)).toContain("Write policy");
    expect(formatRuntimeBoundaries(boundaries, root)).toContain("Target Code Repo");
  });

  it("reports artifacts and readiness pass", () => {
    const root = makeRoot();
    ensureProjectInitialized(root);
    const files = ["prd.md", "ux-design-specification.md", "phase-2-grill-with-docs-2026-05-29.md", "architecture.md", "epics.md"];
    for (const file of files) writeFile(root, `_bmad-output/planning-artifacts/${file}`, `---\nstatus: complete\nworkflowType: test\n---\n# ${file}\n`);
    writeFile(root, "_bmad-output/planning-artifacts/implementation-readiness-report-2026-05-29.md", "---\nreadinessDecision: pass\n---\n# Report\n**Overall Status:** READY\n");
    const cfg = loadPathConfig(root);
    const artifacts = scanArtifactRegistry(cfg);
    const readiness = evaluateReadinessGate(cfg, artifacts);
    expect(artifacts.filter((entry) => entry.requiredForReadiness && entry.status !== "missing")).toHaveLength(6);
    expect(readiness.decision).toBe("pass");
    expect(readiness.implementationMayStart).toBe(true);
  });

  it("selects phase 4 automatic actions by sprint status", () => {
    const root = makeRoot();
    const cfg = loadPathConfig(root);
    const reviewDoc = parseSprintStatusText("development_status:\n  1-1-test: review\n");
    expect(recommendPhase4Automation(reviewDoc, cfg).action).toBe("code-review");
    const backlogDoc = parseSprintStatusText("development_status:\n  1-1-test: backlog\n");
    expect(recommendPhase4Automation(backlogDoc, cfg).action).toBe("create-story");
  });

  it("detects adapters and delegation mode", () => {
    const root = makeRoot();
    writeFile(root, ".pi/settings.json", JSON.stringify({ packages: ["npm:pi-goal-x", "npm:@gotgenes/pi-subagents"] }));
    const mockService: SubagentsServiceLike = { spawn: () => "agent-1" };
    expect(scanPackageAdapters(root).find((adapter) => adapter.name === "pi-goal-x")?.status).toBe("available");
    expect(detectDelegationCapability(root).mode).toBe("degraded-same-session");
    expect(detectDelegationCapability(root, mockService).mode).toBe("real-subagents");
  });

  it("validates delegation contracts and review blocking", () => {
    const contract = createDelegationContract({ owner: "orchestrator", role: "reviewer", objective: "review", context: ["story"], allowedPaths: ["src"], acceptanceCriteria: ["find issues"], dependencies: [], riskLimits: ["read-only"], expectedOutput: "findings", stopCriteria: ["done"] });
    expect(validateDelegationContract(contract)).toHaveLength(0);
    expect(validateDelegationContract({ ...contract, owner: "a and b" }).join("\n")).toContain("exactly one");
    const mockService: SubagentsServiceLike = { spawn: () => "agent-1" };
    writeFile(makeRoot(), ".pi/settings.json", JSON.stringify({ packages: ["npm:@gotgenes/pi-subagents"] }));
    expect(runDelegationContract(contract, { cwd: tempDirs.at(-1)!, service: mockService }).independentExecution).toBe(true);
    expect(reviewBlocksDone([{ title: "bug", detail: "fix", source: "blind", classification: "patch-required" }])).toBe(true);
    expect(synthesizeReviewFindings([{ title: "ok", detail: "none", source: "auditor", classification: "no-action" }, { title: "ok", detail: "none", source: "auditor", classification: "no-action" }]).duplicateCount).toBe(1);
    expect(parseReviewFindings("[patch-required] Fix edge case", "blind-hunter")[0]?.classification).toBe("patch-required");
  });


  it("builds automatic execution plans and degraded parallel review evidence", async () => {
    const root = makeRoot();
    writeFile(root, ".pi/settings.json", JSON.stringify({ packages: [] }));
    writeFile(root, "_bmad-output/implementation-artifacts/1-1-test.md", `# Story 1.1

Status: review

## Acceptance Criteria

1. Given X When Y Then Z
`);
    const cfg = loadPathConfig(root);
    const doc = parseSprintStatusText("development_status:\n  1-1-test: review\n");
    const rec = recommendPhase4Automation(doc, cfg);
    const plan = buildPhase4AutomationExecutionPlan(rec);
    expect(plan.prompt).toContain("Execute the loop");
    expect(plan.prompt).toContain("parallel code review");
    const review = await runParallelReviewDelegation({ cwd: root, storyKey: "1-1-test", storyPath: "_bmad-output/implementation-artifacts/1-1-test.md", changedPaths: [], acceptanceCriteria: ["Given X When Y Then Z"], evidenceLinks: [] });
    expect(review.doneGate).toBe("degraded");
    expect(review.roleResults).toHaveLength(3);
    expect(review.evidencePath).toBeTruthy();
  });

  it("runs parallel review roles with a mock real subagent service", async () => {
    const root = makeRoot();
    writeFile(root, ".pi/settings.json", JSON.stringify({ packages: ["npm:@gotgenes/pi-subagents"] }));
    writeFile(root, "_bmad-output/implementation-artifacts/1-2-test.md", `# Story 1.2

Status: review

## Acceptance Criteria

1. Given A When B Then C
`);
    const spawned: string[] = [];
    const service: SubagentsServiceLike = {
      spawn(type) { const id = `agent-${spawned.length + 1}-${type}`; spawned.push(id); return id; },
      getRecord(id) { return { id, type: "qa-reviewer", description: "review", status: "completed", result: "[no-action] Clean review" }; },
      async waitForAll() { /* mock */ },
    };
    const review = await runParallelReviewDelegation({ cwd: root, service, storyKey: "1-2-test", storyPath: "_bmad-output/implementation-artifacts/1-2-test.md", changedPaths: ["extensions/x.ts"], acceptanceCriteria: ["Given A When B Then C"], evidenceLinks: [] });
    expect(spawned).toHaveLength(3);
    expect(review.independentRoles).toBe(true);
    expect(review.doneGate).toBe("pass");
    expect(review.synthesis.noActionCount).toBe(1);
  });

  it("formats transition and recovery guidance", () => {
    const prompt = formatTransitionPrompt({ current: "2-planning", destination: "3-solutioning", artifacts: ["prd.md"] });
    expect(prompt).toContain("Accept");
    expect(prompt).toContain("Review");
    expect(prompt).toContain("Cancel");
    const sprint = parseSprintStatusText("development_status:\n  1-1-test: in-progress\n");
    expect(determineRecoveryPoint(createDefaultState(), sprint).status).toBe("resume");
  });

  it("summarizes ledger evidence and story files", () => {
    const root = makeRoot();
    ensureProjectInitialized(root);
    writeFile(root, "_bmad-output/evidence/test.md", "# Evidence\n");
    writeFile(root, "_bmad-output/implementation-artifacts/1-1-test.md", "# Story\n");
    const cfg = loadPathConfig(root);
    const state = createDefaultState();
    const summary = summarizeLedger(state, cfg);
    expect(summary.evidenceFiles).toContain("_bmad-output/evidence/test.md");
    expect(summary.storyFiles).toContain("_bmad-output/implementation-artifacts/1-1-test.md");
  });


  it("formats contextual bmad-help with stage and framework commands", () => {
    const state = { ...createDefaultState(), active: true, mode: "autonomous" as const, track: "bmad-method" as const, phase: "4-implementation" as const };
    const sprintStatusRow = {
      module: "BMad Method",
      skill: "bmad-sprint-status",
      displayName: "Sprint Status",
      menuCode: "SS",
      description: "Summarize sprint status and route to next workflow.",
      action: "",
      args: "",
      phase: "4-implementation",
      after: "bmad-sprint-planning",
      before: "",
      required: false,
      outputLocation: "",
      outputs: "",
    };
    const helpRow = {
      ...sprintStatusRow,
      module: "Core",
      skill: "bmad-help",
      displayName: "BMad Help",
      menuCode: "BH",
      description: "Show BMAD help.",
      phase: "anytime",
    };
    const content = formatRuntimeHelp({
      state,
      catalogRows: [sprintStatusRow, helpRow],
      recommendation: { row: sprintStatusRow, blockedBy: [], optionalSamePhase: [], requiredIncomplete: [], completions: [] },
      phase4Automation: { action: "complete", reason: "All non-retrospective sprint stories are done or no planned stories remain." },
    });
    expect(content).toContain("Current BMAD position");
    expect(content).toContain("4-implementation");
    expect(content).toContain("/bmad init");
    expect(content).toContain("--dedicated");
    expect(content).toContain("--git-init");
    expect(content).toContain("--confirm-generic-repo");
    expect(content).toContain("/bmad rename <name>");
    expect(content).toContain("--physical-folder");
    expect(content).toContain("/bmad start");
    expect(content).toContain("/bmad projects");
    expect(content).toContain("/bmad resume");
    expect(content).toContain("/bmad next");
    expect(content).not.toContain("/bmad autopilot");
    expect(content).not.toContain("/bmad autonomous");
    expect(content).toContain("/bmad-help");
    expect(content).toContain("/bmad run SS");
    expect(content).toContain("Phase 4 complete: set `/bmad phase 5-ready-for-use`");
    expect(commandHelp()).toContain("/bmad-help");
    expect(commandHelp()).not.toContain("/bmad autopilot");
    expect(commandHelp()).not.toContain("/bmad autonomous");
    expect(commandHelp()).toContain("5-ready-for-use");
    expect(commandHelp()).toContain("/bmad rename <name>");
    expect(commandHelp()).toContain("/bmad projects");
    expect(commandHelp()).toContain("/bmad resume");
    expect(commandHelp()).toContain("--confirm-folder-rename");
    expect(commandHelp()).toContain("--dedicated");
    expect(commandHelp()).toContain("--no-git-init");
    expect(commandHelp()).toContain("--confirm-generic-repo");
  });

  it("validates config and baseline", () => {
    const root = makeRoot();
    ensureProjectInitialized(root);
    const cfg = loadPathConfig(root);
    expect(validateRuntimeConfig(root, cfg).some((issue) => issue.label === "baseline-policy" && issue.severity === "ok")).toBe(true);
  });
});
