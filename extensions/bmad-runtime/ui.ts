import type { BmadCatalogRow } from "./catalog.js";
import type { Recommendation } from "./scanner.js";
import type { RuntimeState } from "./state.js";

export function formatRow(row: BmadCatalogRow): string {
  const code = row.menuCode ? `[${row.menuCode}] ` : "";
  const required = row.required ? "required" : "optional";
  return `${code}${row.displayName || row.skill} — \`${row.skill}\` (${row.phase}, ${required})`;
}

export function formatRecommendation(rec: Recommendation): string {
  if (!rec.row) return "✅ No incomplete required BMAD workflow detected by the heuristic scanner.";
  const lines = [`Next recommended workflow: ${formatRow(rec.row)}`];
  if (rec.blockedBy.length > 0) {
    lines.push("", "Blocked by:");
    for (const row of rec.blockedBy) lines.push(`- ${formatRow(row)}`);
  }
  if (rec.optionalSamePhase.length > 0) {
    lines.push("", "Optional same-phase tools worth considering:");
    for (const row of rec.optionalSamePhase.slice(0, 8)) lines.push(`- ${formatRow(row)}`);
  }
  return lines.join("\n");
}

export function formatState(state: RuntimeState): string {
  return [
    `active: ${state.active}`,
    `mode: ${state.mode}`,
    `track: ${state.track}`,
    `phase: ${state.phase}`,
    `currentWorkflow: ${state.currentWorkflow ?? "-"}`,
    `currentStory: ${state.currentStory ?? "-"}`,
    `updatedAt: ${state.updatedAt}`,
  ].join("\n");
}

export function commandHelp(): string {
  return `BMAD Runtime for Pi commands:

/bmad start           Activate runtime and start the orchestrator interview
/bmad status          Show state, catalog detection, and next recommendation
/bmad next            Show the next BMAD recommendation
/bmad run <code>      Launch workflow by menu code or skill name, e.g. /bmad run CP
/bmad phase <phase>   Set phase: 1-analysis | 2-planning | 3-solutioning | 4-implementation
/bmad autonomous      Switch to Phase 3/4 autonomous mode
/bmad interview       Switch to human-in-loop interview mode
/bmad exit            Deactivate runtime lock
/bmad help            Show this help`;
}
