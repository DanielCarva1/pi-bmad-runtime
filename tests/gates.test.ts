import { describe, expect, it } from "vitest";
import { shouldBlockDangerousToolCall, shouldBlockMutationInPlanning, shouldBlockSprintStatusMutation, shouldBlockStoryDoneMutation } from "../extensions/bmad-runtime/gates.js";
import { createDefaultState } from "../extensions/bmad-runtime/state.js";

const cwd = process.cwd();

describe("planning mutation gate", () => {
  it("blocks source edits during interview planning", () => {
    const state = { ...createDefaultState(), active: true, phase: "2-planning" as const, mode: "interview" as const };
    const reason = shouldBlockMutationInPlanning(state, cwd, "edit", { path: "src/app.ts" });
    expect(reason).toContain("planning gate blocked");
  });

  it("allows BMAD artifact edits during planning", () => {
    const state = { ...createDefaultState(), active: true, phase: "2-planning" as const, mode: "interview" as const };
    const reason = shouldBlockMutationInPlanning(state, cwd, "write", { path: "_bmad-output/planning-artifacts/prd.md" });
    expect(reason).toBeUndefined();
  });

  it("allows source edits during implementation", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    const reason = shouldBlockMutationInPlanning(state, cwd, "edit", { path: "src/app.ts" });
    expect(reason).toBeUndefined();
  });
});

describe("sprint status gate", () => {
  it("blocks illegal direct story transition to done", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    const reason = shouldBlockSprintStatusMutation(state, cwd, "edit", {
      path: "_bmad-output/implementation-artifacts/sprint-status.yaml",
      edits: [
        {
          oldText: "  1-1-test: ready-for-dev\n",
          newText: "  1-1-test: done\n",
        },
      ],
    });
    expect(reason).toContain("Illegal story transition");
  });

  it("allows legal story transition into progress", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    const reason = shouldBlockSprintStatusMutation(state, cwd, "edit", {
      path: "_bmad-output/implementation-artifacts/sprint-status.yaml",
      edits: [
        {
          oldText: "  1-1-test: ready-for-dev\n",
          newText: "  1-1-test: in-progress\n",
        },
      ],
    });
    expect(reason).toBeUndefined();
  });

  it("blocks invalid full sprint-status writes", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    const reason = shouldBlockSprintStatusMutation(state, cwd, "write", {
      path: "_bmad-output/implementation-artifacts/sprint-status.yaml",
      content: "development_status:\n  1-1-test: shipped\n",
    });
    expect(reason).toContain("Illegal story status");
  });
});

describe("dangerous action gate", () => {
  it("blocks publish and destructive shell commands", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    expect(shouldBlockDangerousToolCall(state, cwd, "bash", { command: "npm publish" })).toContain("safety gate blocked");
    expect(shouldBlockDangerousToolCall(state, cwd, "bash", { command: "rm -rf /tmp/example" })).toContain("safety gate blocked");
  });
});

describe("story done gate", () => {
  it("blocks full story writes that mark incomplete stories done", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    const reason = shouldBlockStoryDoneMutation(state, cwd, "write", {
      path: "_bmad-output/implementation-artifacts/1-1-test-story.md",
      content: `# Story 1.1: Test\n\nStatus: done\n\n## Tasks / Subtasks\n\n- [ ] Finish\n\n## Dev Agent Record\n\n### File List\n`,
    });
    expect(reason).toContain("premature done");
  });
});
