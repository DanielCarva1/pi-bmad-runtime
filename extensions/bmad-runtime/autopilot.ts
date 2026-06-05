import type { BmadPathConfig } from "./paths.js";
import { findFirstStoryWithStatus, type SprintStatusDocument, type SprintStatusEntry } from "./sprint.js";

export type AutopilotAction = "create-story" | "dev-story" | "code-review" | "complete" | "blocked";

export interface AutopilotRecommendation {
  action: AutopilotAction;
  skill?: string;
  story?: SprintStatusEntry;
  reason: string;
  prompt?: string;
  requiredChecks?: string[];
  evidenceRequirements?: string[];
}

export interface AutopilotExecutionPlan {
  recommendation: AutopilotRecommendation;
  loopSteps: string[];
  stopConditions: string[];
  stateUpdates: string[];
  prompt: string;
}

function storyPrompt(skill: string, story?: SprintStatusEntry): string {
  const storyText = story ? `\n\nTarget story key: ${story.key}` : "";
  return `/skill:${skill}${storyText}\n\nBMAD autopilot selected the next Phase 4 workflow. Execute the workflow to its completion or halt condition, then return control to BMAD autopilot.`;
}

function checksFor(action: AutopilotAction): string[] {
  if (action === "complete" || action === "blocked") return [];
  return ["npm run typecheck", "npm test", "npm pack --dry-run or npm run smoke when package shape/release behavior changed"];
}

function evidenceFor(action: AutopilotAction): string[] {
  if (action === "complete" || action === "blocked") return [];
  return ["story file Dev Agent Record", "changed file list", "test/check output", "parallel code review evidence", "sprint-status.yaml transition", "runtime state/work-ledger evidence entry"];
}

export function recommendPhase4Autopilot(doc: SprintStatusDocument | undefined, cfg: BmadPathConfig): AutopilotRecommendation {
  if (!doc) return { action: "blocked", reason: `Sprint status not found at ${cfg.implementation_artifacts}/sprint-status.yaml. Run bmad-sprint-planning first.` };
  const review = findFirstStoryWithStatus(doc, "review");
  if (review) return { action: "code-review", skill: "bmad-code-review", story: review, reason: "First story in review requires code review before completion.", prompt: storyPrompt("bmad-code-review", review), requiredChecks: checksFor("code-review"), evidenceRequirements: evidenceFor("code-review") };
  const inProgress = findFirstStoryWithStatus(doc, "in-progress");
  if (inProgress) return { action: "dev-story", skill: "bmad-dev-story", story: inProgress, reason: "First in-progress story should resume development.", prompt: storyPrompt("bmad-dev-story", inProgress), requiredChecks: checksFor("dev-story"), evidenceRequirements: evidenceFor("dev-story") };
  const ready = findFirstStoryWithStatus(doc, "ready-for-dev");
  if (ready) return { action: "dev-story", skill: "bmad-dev-story", story: ready, reason: "First ready story should be implemented.", prompt: storyPrompt("bmad-dev-story", ready), requiredChecks: checksFor("dev-story"), evidenceRequirements: evidenceFor("dev-story") };
  const backlog = findFirstStoryWithStatus(doc, "backlog");
  if (backlog) return { action: "create-story", skill: "bmad-create-story", story: backlog, reason: "No active story exists; create the next backlog story context before development.", prompt: storyPrompt("bmad-create-story", backlog), requiredChecks: checksFor("create-story"), evidenceRequirements: evidenceFor("create-story") };
  return { action: "complete", reason: "All non-retrospective sprint stories are done or no planned stories remain." };
}

export function buildAutopilotExecutionPlan(rec: AutopilotRecommendation): AutopilotExecutionPlan {
  const story = rec.story?.key ?? "no-story";
  const loopSteps = rec.action === "create-story"
    ? ["Create the story file from canonical epics with concrete ACs", "Run dev-story implementation", "Run local checks", "Run parallel code review roles", "Patch or stop on findings", "Record evidence and update sprint/state/ledger"]
    : rec.action === "dev-story"
      ? ["Resume or start dev-story", "Implement scoped changes", "Run local checks", "Move to review", "Run parallel code review roles", "Patch or stop on findings", "Record evidence and update sprint/state/ledger"]
      : rec.action === "code-review"
        ? ["Run Blind Hunter, Edge Case Hunter, and Acceptance Auditor with bounded context", "Deduplicate and classify findings", "Patch required issues or stop for decision-needed findings", "Only mark done if done gate passes", "Record evidence and update sprint/state/ledger"]
        : [];
  const stopConditions = ["readiness missing or waived scope expired", "no eligible story", "failed local check that cannot be fixed safely", "patch-required review finding remains", "decision-needed finding or artifact contradiction", "credentials/paid/destructive/external-action/reference-project/baseline blocker"];
  const stateUpdates = ["current workflow/story", "story Dev Agent Record", "sprint-status.yaml", "work ledger/evidence path", "runtime command evidence when launched"];
  const prompt = [
    `/skill:${rec.skill ?? "bmad-runtime-for-pi"}`, "", `BMAD Phase 4 autopilot execution plan for ${story}.`, `Action: ${rec.action}`, `Reason: ${rec.reason}`, "", "Execute the loop, not just a recommendation:",
    ...loopSteps.map((step, index) => `${index + 1}. ${step}`), "", "Required checks:", ...(rec.requiredChecks?.length ? rec.requiredChecks.map((check) => `- ${check}`) : ["- none"]),
    "Evidence requirements:", ...(rec.evidenceRequirements?.length ? rec.evidenceRequirements.map((item) => `- ${item}`) : ["- none"]), "Stop conditions:", ...stopConditions.map((item) => `- ${item}`), "", "Do not mark the story done until implementation, checks, review synthesis, and evidence all pass. Return to `/bmad autopilot` after a successful iteration.",
  ].join("\n");
  return { recommendation: rec, loopSteps, stopConditions, stateUpdates, prompt };
}

export function formatAutopilotRecommendation(rec: AutopilotRecommendation): string {
  const story = rec.story ? `\nStory: ${rec.story.key} (${rec.story.status})` : "";
  const skill = rec.skill ? `\nSkill: ${rec.skill}` : "";
  const checks = rec.requiredChecks?.length ? `\nRequired checks: ${rec.requiredChecks.join(", ")}` : "";
  const evidence = rec.evidenceRequirements?.length ? `\nEvidence: ${rec.evidenceRequirements.join(", ")}` : "";
  return [`BMAD autopilot recommendation: ${rec.action}`, `Reason: ${rec.reason}`, story, skill, checks, evidence].filter(Boolean).join("\n");
}
