import type { ArtifactRegistryEntry } from "./artifacts.js";
import type { RuntimeState } from "./state.js";

export interface GrillClosureRecommendation {
  needed: boolean;
  reason: string;
  target?: string;
}

export function recommendGrillClosure(state: RuntimeState, artifacts: ArtifactRegistryEntry[]): GrillClosureRecommendation {
  const phaseNeedsGrill = state.phase === "1-analysis" || state.phase === "2-planning";
  const phase2Grill = artifacts.find((entry) => entry.id === "phase2-grill");
  const hasPlanningArtifact = artifacts.some((entry) => (entry.id === "prd" || entry.id === "ux") && entry.status !== "missing");
  if (!phaseNeedsGrill || !hasPlanningArtifact) return { needed: false, reason: "No Phase 1/2 closure grill is currently required." };
  if (phase2Grill && phase2Grill.status !== "missing") return { needed: false, reason: `Phase closure grill evidence exists at ${phase2Grill.path}.` };
  return {
    needed: true,
    reason: "Phase 1/2 planning artifacts exist but grill-with-docs closure evidence is missing.",
    target: "PRD + UX + project context",
  };
}

export function formatGrillClosureRecommendation(rec: GrillClosureRecommendation): string {
  return rec.needed
    ? `Grill closure: required — ${rec.reason}\nRecommended command: /bmad grill ${rec.target ?? "current planning artifacts"}`
    : `Grill closure: not required — ${rec.reason}`;
}
