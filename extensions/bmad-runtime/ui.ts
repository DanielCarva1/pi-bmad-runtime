import type { Phase4AutomationRecommendation } from "./phase4-automation.js";
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
  const lastRun = state.workflowHistory.at(-1);
  return [
    `active: ${state.active}`,
    `mode: ${state.mode}`,
    `track: ${state.track}`,
    `phase: ${state.phase}`,
    `currentWorkflow: ${state.currentWorkflow ?? "-"}`,
    `currentStory: ${state.currentStory ?? "-"}`,
    `workflowHistory: ${state.workflowHistory.length}`,
    `lastRun: ${lastRun ? `${lastRun.skill} @ ${lastRun.launchedAt}` : "-"}`,
    `updatedAt: ${state.updatedAt}`,
  ].join("\n");
}


const PHASE_LABELS: Record<string, string> = {
  "0-init": "Setup / not initialized",
  "1-analysis": "Analysis / discovery",
  "2-planning": "Planning / PRD + UX",
  "3-solutioning": "Solutioning / architecture + epics + readiness",
  "4-implementation": "Implementation / sprint + story loop",
  "5-ready-for-use": "Ready for use / release + monitoring",
  anytime: "Anytime helper",
};

function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ? `${phase} — ${PHASE_LABELS[phase]}` : phase;
}

function dash(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : "-";
}

function workflowCommand(row: BmadCatalogRow): string {
  const target = row.menuCode || row.skill;
  const invocation = row.action ? `${target} ${row.action}` : target;
  return `/bmad run ${invocation}`;
}

function formatWorkflowChoice(row: BmadCatalogRow): string {
  const code = row.menuCode ? `[${row.menuCode}] ` : "";
  const required = row.required ? "required" : "optional";
  const desc = row.description ? ` — ${row.description}` : "";
  return `- ${code}${row.displayName || row.skill}: \`${workflowCommand(row)}\` (skill: \`${row.skill}\`, ${required})${desc}`;
}

function uniqueRows(rows: BmadCatalogRow[]): BmadCatalogRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.menuCode || row.skill}:${row.action || ""}:${row.displayName || row.skill}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface RuntimeHelpInput {
  state: RuntimeState;
  recommendation: Recommendation;
  catalogRows: BmadCatalogRow[];
  phase4Automation?: Phase4AutomationRecommendation;
}

export function formatRuntimeHelp({ state, recommendation, catalogRows, phase4Automation }: RuntimeHelpInput): string {
  const currentPhaseRows = uniqueRows(catalogRows.filter((row) => row.phase === state.phase));
  const anytimeRows = uniqueRows(catalogRows.filter((row) => row.phase === "anytime" && ["Core", "BMad Method"].includes(row.module))).slice(0, 10);
  const lastRun = state.workflowHistory.at(-1);
  const readyForUseLine = state.phase === "5-ready-for-use"
    ? "Ready for use: no Phase 4 story loop should continue unless a new version/story is explicitly started."
    : undefined;
  const phase4Line = phase4Automation?.action === "complete"
    ? `Phase 4 complete: set \`/bmad phase 5-ready-for-use\` when release/install smoke and handoff are captured.`
    : phase4Automation
      ? `Phase 4 automatic next step: **${phase4Automation.action}** — ${phase4Automation.reason}`
      : undefined;
  const nextLine = readyForUseLine
    ? readyForUseLine
    : phase4Line
    ? phase4Line
    : recommendation.row
      ? `Next recommended workflow: ${formatRow(recommendation.row)}`
      : "Next recommended workflow: ✅ none detected";

  return [
    "# BMAD Help",
    "",
    "Use this when you are inside `pi` and want to understand where you are in Pi+BMad and what to run next.",
    "",
    "## Current BMAD position",
    "",
    `- Runtime active: **${state.active}**`,
    `- Mode: **${state.mode}**`,
    `- Track: **${state.track}**`,
    `- Phase: **${phaseLabel(state.phase)}**`,
    `- Current workflow: **${dash(state.currentWorkflow)}**`,
    `- Current story: **${dash(state.currentStory)}**`,
    `- Last workflow: **${lastRun ? `${lastRun.skill} @ ${lastRun.launchedAt}` : "-"}**`,
    `- Updated at: **${state.updatedAt}**`,
    `- ${nextLine}`,
    "",
    "## Core framework commands",
    "",
    "- `/bmad init` — initialize runtime state and artifact folders in this project",
    "- `/bmad init --dedicated <project-name> [--root <path>] [--git-init|--no-git-init]` — create a dedicated local BMAD workspace",
    "- `/bmad init --confirm-generic-repo` — explicitly initialize BMAD in the current generic git repo",
    "- `/bmad init --record-evidence` — initialize and write an evidence packet",
    "- `/bmad rename <name>` — rename project display name while preserving Stable ID and physical folder",
    "- `/bmad rename --physical-folder <folder> --confirm-folder-rename` — preflight an explicit physical folder rename without moving it",
    "- `/bmad-start` — start BMAD Runtime with a conversational project picker",
    "- `/bmad start` — same as `/bmad-start`",
    "- `/bmad projects` — list known projects read-only; use `details <number|name|projectId>` for details on demand",
    "- `/bmad resume <id|name|alias>` — resume one registered project without relying on current cwd",
    "- `/bmad status` — show state, gates, artifacts, adapters, sprint status and recommendation",
    "- `/bmad next` — show the next BMAD recommendation",
    "- `/bmad run next` — launch the next recommended workflow",
    "- `/bmad run <code|skill>` — launch a workflow from the BMAD catalog, e.g. `/bmad run CP`",
    "- `/bmad phase <phase>` — set phase: `1-analysis`, `2-planning`, `3-solutioning`, `4-implementation`, `5-ready-for-use`",
    "- `/bmad review <story>` — run Blind Hunter, Edge Case Hunter and Acceptance Auditor review roles",
    "- `/bmad handoff [note]` — write a compact resume handoff for the next session",
    "- `/bmad health` — diagnose package/config/state/artifacts/adapters",
    "- `/bmad readiness` — show implementation readiness gate",
    "- `/bmad grill [target]` — run grill-with-docs pressure testing",
    "- `/bmad help` — show BMAD runtime command reference",
    "- `/bmad-help` — show this contextual help screen",
    "- `/bmad exit` — deactivate the runtime lock",
    "",
    "## Workflows for the current phase",
    "",
    ...(currentPhaseRows.length ? currentPhaseRows.map(formatWorkflowChoice) : ["- No catalog workflows found for this phase."]),
    "",
    "## Useful anytime BMAD helpers",
    "",
    ...(anytimeRows.length ? anytimeRows.map(formatWorkflowChoice) : ["- No anytime helpers found in the BMAD catalog."]),
    "",
    "## Startup pattern",
    "",
    "```bash",
    "cd <your-project>",
    "pi",
    "```",
    "",
    "Then inside Pi:",
    "",
    "```text",
    "/bmad init",
    "/bmad-start",
    "/bmad-help",
    "```",
  ].join("\n");
}

export function commandHelp(): string {
  return `BMAD Runtime for Pi commands:

/bmad init            Initialize local runtime state, project identity, baseline lock, and artifact folders
/bmad init --dedicated <project-name> [--root <path>] [--git-init|--no-git-init]    Create a dedicated local BMAD workspace; optional git init is local-only
/bmad init --confirm-generic-repo    Explicitly initialize BMAD in the current generic git repo
/bmad init --record-evidence    Initialize and append a project evidence packet
/bmad rename <name>   Rename project display name, preserve Stable ID, and keep physical folder unchanged
/bmad rename --physical-folder <folder> --confirm-folder-rename   Preflight a folder rename; runtime does not move the folder
/bmad projects        List known projects read-only; details: /bmad projects details <number|name|projectId>
/bmad resume <id|name|alias>   Resume one registered project without relying on current cwd
/bmad health          Diagnose package, BMAD config, state, artifacts, agents, and optional adapters
/bmad health --record-evidence  Run health and append a project evidence packet
/bmad readiness       Show implementation readiness gate card
/bmad transition      Show accept/review/cancel confirmation for the next BMAD transition
/bmad-start           Start BMAD Runtime with a conversational project picker
/bmad start           Same as /bmad-start
/bmad status          Show state, catalog detection, and next recommendation
/bmad next            Show the next BMAD recommendation
/bmad run <code>      Launch workflow by menu code or skill name, e.g. /bmad run CP
/bmad run next        Launch the next recommended required workflow
/bmad run --same-session <code>  Launch without fresh-session handoff
/bmad run --fresh <code>         Launch in a fresh session without confirmation
/bmad phase <phase>   Set phase: 1-analysis | 2-planning | 3-solutioning | 4-implementation | 5-ready-for-use
/bmad review <story>  Run BMAD parallel review roles and write review evidence
/bmad handoff [note]  Write a compact resume handoff for the next session
/bmad interview       Switch to human-in-loop interview mode
/bmad grill [target]  Run grill-with-docs against current plan or target
/bmad exit            Deactivate runtime lock
/bmad help            Show command reference
/bmad-help            Show contextual stage + command help`;
}
