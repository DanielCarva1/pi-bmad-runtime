import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { activateState, createDefaultState, getStateFile, isAutonomousPhase, isReadyForUsePhase, loadState, recordWorkflowLaunch, setPhase, summarizeStateForSession } from "../extensions/bmad-runtime/state.js";

describe("runtime state", () => {
  it("records workflow launches and keeps currentWorkflow in sync", () => {
    const state = createDefaultState();
    const next = recordWorkflowLaunch(state, {
      skill: "bmad-create-prd",
      displayName: "Create PRD",
      menuCode: "CP",
      phase: "2-planning",
      launchArgs: "",
      launchedAt: "2026-05-18T00:00:00.000Z",
    });

    expect(next.currentWorkflow).toBe("bmad-create-prd");
    expect(next.workflowHistory).toHaveLength(1);
    expect(next.workflowHistory[0]).toMatchObject({ skill: "bmad-create-prd", menuCode: "CP", mode: "interview" });
  });

  it("caps workflow history", () => {
    let state = createDefaultState();
    for (let i = 0; i < 60; i++) {
      state = recordWorkflowLaunch(state, { skill: `skill-${i}`, phase: "test" });
    }
    expect(state.workflowHistory).toHaveLength(50);
    expect(state.workflowHistory[0]?.skill).toBe("skill-10");
  });

  it("normalizes legacy completion history without carrying bulky artifact fields", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bmad-state-"));
    const file = getStateFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      ...createDefaultState(),
      workflowHistory: [{
        workflow: "bmad-code-review",
        status: "complete",
        completedAt: "2026-06-09T07:46:00.000Z",
        phase: "4-implementation",
        story: "3.2",
        storyKey: "3-2-dedicated-local-project-workspace-com-root-preference-e-folder-estavel",
        artifacts: ["large-artifact.md"],
        checks: ["npm test"],
        summary: "Long legacy completion payload",
      }],
    }, null, 2), "utf8");

    const state = loadState(root);
    expect(state.workflowHistory).toHaveLength(1);
    expect(state.workflowHistory[0]).toMatchObject({
      skill: "bmad-code-review",
      launchedAt: "2026-06-09T07:46:00.000Z",
      launchArgs: "3-2-dedicated-local-project-workspace-com-root-preference-e-folder-estavel",
    });
    expect("artifacts" in (state.workflowHistory[0] as unknown as Record<string, unknown>)).toBe(false);
    expect("checks" in (state.workflowHistory[0] as unknown as Record<string, unknown>)).toBe(false);
  });

  it("summarizes state for session entries without embedding full history", () => {
    const state = recordWorkflowLaunch(createDefaultState(), {
      skill: "bmad-create-story",
      phase: "4-implementation",
      launchArgs: "3.3",
      launchedAt: "2026-06-09T08:00:00.000Z",
    });

    const summary = summarizeStateForSession(state);
    expect(summary.workflowHistoryCount).toBe(1);
    expect(summary.lastRun).toMatchObject({ skill: "bmad-create-story", launchArgs: "3.3" });
    expect("workflowHistory" in (summary as unknown as Record<string, unknown>)).toBe(false);
  });

  it("treats ready-for-use as an active but non-autonomous phase", () => {
    const state = setPhase({ ...createDefaultState(), active: true, mode: "autonomous", currentWorkflow: "bmad-dev-story", currentStory: "4.5" }, "5-ready-for-use");

    expect(state.phase).toBe("5-ready-for-use");
    expect(state.mode).toBe("paused");
    expect(state.currentWorkflow).toBeNull();
    expect(state.currentStory).toBeNull();
    expect(isReadyForUsePhase(state)).toBe(true);
    expect(isAutonomousPhase(state)).toBe(false);
  });

  it("keeps ready-for-use paused when state is activated again", () => {
    const state = activateState({ ...createDefaultState(), active: false, mode: "paused", phase: "5-ready-for-use", currentWorkflow: "bmad-dev-story", currentStory: "4.5" });

    expect(state.active).toBe(true);
    expect(state.phase).toBe("5-ready-for-use");
    expect(state.mode).toBe("paused");
    expect(state.currentWorkflow).toBeNull();
    expect(state.currentStory).toBeNull();
  });
});
