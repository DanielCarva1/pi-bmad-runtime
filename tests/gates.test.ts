import { describe, expect, it } from "vitest";
import { shouldBlockMutationInPlanning } from "../extensions/bmad-runtime/gates.js";
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
