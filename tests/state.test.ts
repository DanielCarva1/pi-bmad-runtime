import { describe, expect, it } from "vitest";
import { createDefaultState, recordWorkflowLaunch } from "../extensions/bmad-runtime/state.js";

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
});
