import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPhase4AutomationExecutionPlan, recommendPhase4Automation } from "../extensions/bmad-runtime/phase4-automation.js";
import { loadPathConfig } from "../extensions/bmad-runtime/paths.js";
import { ensureProjectRegistered } from "../extensions/bmad-runtime/project.js";
import { resolveActiveProject } from "../extensions/bmad-runtime/resolution.js";
import { buildContinuationBootstrapPrompt, buildStartRouterPrompt } from "../extensions/bmad-runtime/start.js";
import { loadState, saveState } from "../extensions/bmad-runtime/state.js";
import { parseSprintStatusText } from "../extensions/bmad-runtime/sprint.js";

let tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-context-budget-"));
  tempDirs.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function seedReadyArtifacts(root: string): void {
  for (const file of ["prd.md", "ux-design-specification.md", "phase-2-grill-with-docs-2026-05-29.md", "architecture.md", "epics.md"]) {
    writeFile(root, `_bmad-output/planning-artifacts/${file}`, `---\nstatus: complete\nworkflowType: test\n---\n# ${file}\n`);
  }
  writeFile(root, "_bmad-output/planning-artifacts/implementation-readiness-report-2026-05-29.md", "---\nreadinessDecision: pass\n---\n# Report\n**Overall Status:** READY\n");
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("context budget audit", () => {
  it("is registered as a read-only package audit", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    const doc = fs.readFileSync(path.join(process.cwd(), "docs", "context-budget.md"), "utf8");

    expect(pkg.scripts["audit:context"]).toBe("node scripts/context-budget-audit.mjs");
    expect(doc).toContain("npm run audit:context");
    expect(doc).toContain("Full BMAD docs are fallback references, not bootstrap input.");
  });

  it("passes against the shipped compact contracts without external writes", () => {
    const result = spawnSync("node", ["scripts/context-budget-audit.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { ok: boolean; externalWrites: boolean; compactBootstrapBytes: number };
    expect(output.ok).toBe(true);
    expect(output.externalWrites).toBe(false);
    expect(output.compactBootstrapBytes).toBeLessThanOrEqual(25000);
  });

  it("bounds generated start, resume and Phase 4 execution prompts", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(root, { runtimeHome });
    seedReadyArtifacts(root);
    const longHandoff = `# Handoff\n\n${"Resume detail.\n".repeat(1200)}\nTail should not be required.\n`;
    writeFile(root, ".bmad-runtime/handoffs/latest-handoff.md", longHandoff);
    writeFile(root, "_bmad-output/implementation-artifacts/sprint-status.yaml", [
      "generated: 2026-06-09T00:00:00Z",
      "last_updated: 2026-06-09T00:00:00Z",
      "project: Test",
      "development_status:",
      "  epic-4: in-progress",
      "  4-7-context-budget-guard: backlog",
      "  epic-4-retrospective: optional",
      "",
    ].join("\n"));
    const state = saveState(root, { ...loadState(root), active: true, mode: "autonomous", phase: "4-implementation", currentWorkflow: "bmad-create-story", currentStory: "4.7" });
    const resolution = await resolveActiveProject(root, { runtimeHome });

    const startPrompt = buildStartRouterPrompt(root, resolution, state);
    const resumePrompt = buildContinuationBootstrapPrompt(root, resolution, state);
    const cfg = loadPathConfig(root);
    const sprint = parseSprintStatusText(fs.readFileSync(path.join(cfg.implementation_artifacts, "sprint-status.yaml"), "utf8"));
    const rec = recommendPhase4Automation(sprint, cfg, { readinessMayStart: true, readinessDecision: "pass" });
    const executionPrompt = buildPhase4AutomationExecutionPlan(rec).prompt;

    expect(bytes(startPrompt)).toBeLessThanOrEqual(10000);
    expect(bytes(resumePrompt)).toBeLessThanOrEqual(18000);
    expect(bytes(executionPrompt)).toBeLessThanOrEqual(9000);
    expect(resumePrompt).not.toContain("Tail should not be required.");
    expect(startPrompt).not.toContain("llms-full");
    expect(resumePrompt).not.toContain("llms-full");
    expect(executionPrompt).not.toContain("llms-full");
  });
});
