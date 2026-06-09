import { describe, expect, it } from "vitest";
import { classifyPromptRequirement, decideWorkflowLaunchPolicy, formatOwnerApprovalBlock, formatPromptPolicySummary, isTechnicalAutonomousPhase } from "../extensions/bmad-runtime/prompt-policy.js";
import { createDefaultState } from "../extensions/bmad-runtime/state.js";

describe("prompt policy", () => {
  it("treats routine Phase 3/4 workflow prompts as automatic", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };

    expect(isTechnicalAutonomousPhase(state)).toBe(true);
    expect(classifyPromptRequirement({ kind: "step-transition", state })).toMatchObject({
      decision: "automatic",
      requiresOwnerApproval: false,
    });

    const launch = decideWorkflowLaunchPolicy(state, "ask", true, true);
    expect(launch.launchFresh).toBe(true);
    expect(launch.askForConfirmation).toBe(false);
    expect(launch.reason).toContain("without mechanical confirmation");
  });

  it("keeps human-in-loop phases eligible for concise user questions", () => {
    const state = { ...createDefaultState(), active: true, phase: "2-planning" as const, mode: "interview" as const };
    const launch = decideWorkflowLaunchPolicy(state, "ask", true, true);
    expect(launch.launchFresh).toBe(false);
    expect(launch.askForConfirmation).toBe(true);
    expect(classifyPromptRequirement({ kind: "workflow-fresh-session", state }).decision).toBe("ask-user");
  });

  it("does not treat ready-for-use as technical automation", () => {
    const state = { ...createDefaultState(), active: true, phase: "5-ready-for-use" as const, mode: "autonomous" as const };

    expect(isTechnicalAutonomousPhase(state)).toBe(false);
    expect(classifyPromptRequirement({ kind: "step-transition", state }).decision).toBe("ask-user");
  });

  it("requires Owner approval for high-risk categories", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    for (const kind of ["credentials", "paid-service", "destructive-action", "deploy-publication", "remote-write", "waiver", "scope-expansion", "product-terminology-decision"] as const) {
      const decision = classifyPromptRequirement({ kind, state });
      expect(decision.decision).toBe("owner-approval-required");
      expect(decision.requiresOwnerApproval).toBe(true);
      expect(decision.writeOccurred).toBe(false);
      expect(formatOwnerApprovalBlock(decision)).toContain("Owner approval required");
      expect(formatOwnerApprovalBlock(decision)).toContain("Evidence required");
    }
  });

  it("summarizes routine automation and Owner approval boundaries for status", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    const summary = formatPromptPolicySummary(state);
    expect(summary).toContain("Prompt Policy");
    expect(summary).toContain("automatic; no mechanical confirmation");
    expect(summary).toContain("Owner approval required");
    expect(summary).toContain("paid external services");
  });
});
