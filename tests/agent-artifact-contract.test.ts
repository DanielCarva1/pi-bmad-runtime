import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPhase4AutomationExecutionPlan, recommendPhase4Automation } from "../extensions/bmad-runtime/phase4-automation.js";
import { parseSprintStatusText } from "../extensions/bmad-runtime/sprint.js";

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("agent artifact contract", () => {
  it("ships compact story, epic, sprint and context-budget rules", () => {
    const doc = read("docs/agent-artifact-contract.md");
    const contract = read("docs/agent-operating-contract.md");
    const skill = read("skills/bmad-runtime-for-pi/SKILL.md");
    const pkg = JSON.parse(read("package.json")) as { files: string[] };

    expect(pkg.files).toContain("docs/");
    expect(doc).toContain("## Sprint Status");
    expect(doc).toContain("development_status:");
    expect(doc).toContain("## Story File");
    expect(doc).toContain("## Agent Scope");
    expect(doc).toContain("## Epic File");
    expect(doc).toContain("## Ephemeral Task Packets");
    expect(doc).toContain("Recommended task-packet locations:");
    expect(doc).toContain("Runtime cleanup classification:");
    expect(doc).toContain("## Context Budget");
    expect(doc).toContain("Given <state> When <action> Then <observable result>");
    expect(contract).toContain("docs/agent-artifact-contract.md");
    expect(skill).toContain("docs/agent-artifact-contract.md");
    expect(skill).toContain("compact markdown/YAML/state-machine artifacts");
    expect(doc).not.toMatch(/\/bmad autopilot/i);
    expect(doc).not.toMatch(/Hermes|ZICO/);
  });

  it("injects compact artifact rules into Phase 4 execution prompts", () => {
    const doc = parseSprintStatusText("development_status:\n  1-1-first-story: ready-for-dev\n");
    const rec = recommendPhase4Automation(doc, {
      readinessPassed: true,
      readinessWaived: false,
      projectRoot: process.cwd(),
      output_folder: "_bmad-output",
      planning_artifacts: "_bmad-output/planning-artifacts",
      implementation_artifacts: "_bmad-output/implementation-artifacts",
    });
    const plan = buildPhase4AutomationExecutionPlan(rec);

    expect(plan.prompt).toContain("Compact artifact rules:");
    expect(plan.prompt).toContain("docs/agent-artifact-contract.md");
    expect(plan.prompt).toContain("Acceptance Criteria, Agent Scope, Tasks / Subtasks, Dev Agent Record, File List, Senior Developer Review");
    expect(plan.prompt).toContain("sprint-status.yaml as the compact index");
    expect(plan.prompt).not.toContain("/bmad autopilot");
  });
});
