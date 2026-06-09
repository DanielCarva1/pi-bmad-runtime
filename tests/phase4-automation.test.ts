import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPhase4AutomationExecutionPlan, recommendPhase4Automation } from "../extensions/bmad-runtime/phase4-automation.js";
import { evaluateDiffApprovalPolicy } from "../extensions/bmad-runtime/diff-approval.js";
import { loadPathConfig } from "../extensions/bmad-runtime/paths.js";
import { parseSprintStatusText } from "../extensions/bmad-runtime/sprint.js";

let tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-phase4-automation-"));
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

describe("Phase 4 automation execution context", () => {
  it("blocks story execution when readiness has not passed or been waived", () => {
    const root = makeRoot();
    const cfg = loadPathConfig(root);
    const doc = parseSprintStatusText("development_status:\n  1-1-test: ready-for-dev\n");

    const rec = recommendPhase4Automation(doc, cfg, { readinessMayStart: false, readinessDecision: "blocked" });

    expect(rec.action).toBe("blocked");
    expect(rec.reason).toContain("readiness decision blocked");
    expect(rec.blockers?.join("\n")).toContain("readiness pass or scoped waiver");
  });

  it("includes story dependencies and allowed paths in the execution plan", () => {
    const root = makeRoot();
    const cfg = loadPathConfig(root);
    writeFile(root, "_bmad-output/implementation-artifacts/1-2-child.md", `# Story 1.2

Status: ready-for-dev

## Dependencies

- 1-1-parent

## Dev Notes

### Owner, allowed paths e contrato de escopo

- Allowed paths principais:
  - \`extensions/bmad-runtime/phase4-automation.ts\`
  - \`tests/phase4-automation.test.ts\`
`);
    const doc = parseSprintStatusText([
      "development_status:",
      "  1-1-parent: done",
      "  1-2-child: ready-for-dev",
    ].join("\n"));

    const rec = recommendPhase4Automation(doc, cfg, { readinessMayStart: true, readinessDecision: "pass" });
    const plan = buildPhase4AutomationExecutionPlan(rec);

    expect(rec.action).toBe("dev-story");
    expect(rec.story?.key).toBe("1-2-child");
    expect(rec.storyContext?.dependencies).toContain("1-1-parent");
    expect(rec.storyContext?.allowedPaths).toContain("extensions/bmad-runtime/phase4-automation.ts");
    expect(plan.prompt).toContain("Allowed paths:");
    expect(plan.prompt).toContain("Dependencies:");
    expect(plan.prompt).toContain("1-1-parent");
  });

  it("blocks when declared dependencies are not done", () => {
    const root = makeRoot();
    const cfg = loadPathConfig(root);
    writeFile(root, "_bmad-output/implementation-artifacts/1-2-child.md", `# Story 1.2

Status: ready-for-dev

## Dependencies

- 1-1-parent
`);
    const doc = parseSprintStatusText([
      "development_status:",
      "  1-1-parent: backlog",
      "  1-2-child: ready-for-dev",
    ].join("\n"));

    const rec = recommendPhase4Automation(doc, cfg, { readinessMayStart: true, readinessDecision: "pass" });
    const plan = buildPhase4AutomationExecutionPlan(rec);

    expect(rec.action).toBe("blocked");
    expect(rec.reason).toContain("dependencies are done");
    expect(rec.blockers?.join("\n")).toContain("not done");
    expect(plan.prompt).toContain("Blockers:");
    expect(plan.prompt).toContain("1-1-parent");
  });

  it("blocks before the story loop when pi-show-diffs approval is blocking", () => {
    const root = makeRoot();
    const cfg = loadPathConfig(root);
    writeFile(root, ".pi/settings.json", JSON.stringify({ packages: [{ source: "pi-show-diffs", approval: "manual" }] }));
    const doc = parseSprintStatusText([
      "development_status:",
      "  1-1-diff: ready-for-dev",
    ].join("\n"));

    const rec = recommendPhase4Automation(doc, cfg, { readinessMayStart: true, readinessDecision: "pass", diffApproval: evaluateDiffApprovalPolicy(root) });
    const plan = buildPhase4AutomationExecutionPlan(rec);

    expect(rec.action).toBe("blocked");
    expect(rec.reason).toContain("diff approval policy");
    expect(rec.blockers?.join("\n")).toContain("Configure diff approval");
    expect(plan.prompt).toContain("Diff approval policy");
    expect(plan.prompt).toContain("approval 'manual'");
    expect(plan.prompt).toContain("Do not execute the loop");
    expect(plan.prompt).not.toContain("Execute the loop, not just a recommendation");
  });

  it("adds diff approval bypass evidence when automation can proceed", () => {
    const root = makeRoot();
    const cfg = loadPathConfig(root);
    writeFile(root, ".pi/settings.json", JSON.stringify({ packages: [{ source: "pi-show-diffs", autoApprove: true }] }));
    const doc = parseSprintStatusText([
      "development_status:",
      "  1-1-diff: ready-for-dev",
    ].join("\n"));

    const rec = recommendPhase4Automation(doc, cfg, { readinessMayStart: true, readinessDecision: "pass", diffApproval: evaluateDiffApprovalPolicy(root) });
    const plan = buildPhase4AutomationExecutionPlan(rec);

    expect(rec.action).toBe("dev-story");
    expect(rec.diffApproval?.mode).toBe("bypass");
    expect(rec.evidenceRequirements?.join("\n")).toContain("diff approval policy");
    expect(plan.prompt).toContain("auto-approval/bypass");
  });

  it("reopens an active story for retry when check evidence failed", () => {
    const root = makeRoot();
    const cfg = loadPathConfig(root);
    writeFile(root, "_bmad-output/implementation-artifacts/1-1-retry.md", `# Story 1.1

Status: review

## Dev Agent Record

### Debug Log References

- npm test - FAIL.

### File List

- extensions/bmad-runtime/phase4.ts
`);
    const doc = parseSprintStatusText([
      "development_status:",
      "  1-1-retry: review",
    ].join("\n"));

    const rec = recommendPhase4Automation(doc, cfg, { readinessMayStart: true, readinessDecision: "pass" });
    const plan = buildPhase4AutomationExecutionPlan(rec);

    expect(rec.action).toBe("retry");
    expect(rec.skill).toBe("bmad-dev-story");
    expect(rec.storyContext?.failurePolicy.classification).toBe("retryable");
    expect(plan.prompt).toContain("Action: retry");
    expect(plan.prompt).toContain("retry scheduled: yes");
    expect(plan.prompt).not.toContain("/bmad autopilot");
  });

  it("blocks accepted-risk candidates until Owner approval, scope and evidence exist", () => {
    const root = makeRoot();
    const cfg = loadPathConfig(root);
    writeFile(root, "_bmad-output/implementation-artifacts/1-2-risk.md", `# Story 1.2

Status: review

## Senior Developer Review (AI)

- [accepted-risk] Residual risk is acceptable, but approval metadata is missing.
`);
    const doc = parseSprintStatusText([
      "development_status:",
      "  1-2-risk: review",
    ].join("\n"));

    const rec = recommendPhase4Automation(doc, cfg, { readinessMayStart: true, readinessDecision: "pass" });

    expect(rec.action).toBe("blocked");
    expect(rec.reason).toContain("accepted-risk-candidate");
    expect(rec.blockers?.join("\n")).toContain("Owner");
  });

  it("stops automation for decision-needed findings with evidence in blockers", () => {
    const root = makeRoot();
    const cfg = loadPathConfig(root);
    writeFile(root, "_bmad-output/implementation-artifacts/1-1-decision.md", `# Story 1.1

Status: review

## Acceptance Criteria

- Given a decision, When automation reaches it, Then it stops.

## Senior Developer Review (AI)

- [decision-needed] Owner must choose whether to expand scope. Evidence: _bmad-output/evidence/story-1-1-review.md

## Dev Agent Record

### Debug Log References

- npm test - PASS.

### File List

- extensions/bmad-runtime/phase4.ts
`);
    writeFile(root, "_bmad-output/evidence/story-1-1-review.md", "# Review evidence\n");
    const doc = parseSprintStatusText([
      "generated: 2026-06-09T00:00:00Z",
      "last_updated: 2026-06-09T00:00:00Z",
      "project: Test",
      "development_status:",
      "  epic-1: in-progress",
      "  1-1-decision: review",
      "  epic-1-retrospective: optional",
      "",
    ].join("\n"));

    const rec = recommendPhase4Automation(doc, cfg, { readinessMayStart: true });

    expect(rec.action).toBe("blocked");
    expect(rec.reason).toContain("decision-needed");
    expect(rec.blockers?.join("\n")).toContain("expand scope");
    expect(rec.blockers?.join("\n")).toContain("_bmad-output/evidence/story-1-1-review.md");
  });
});
