import type { RuntimeState } from "./state.js";
import type { SprintStatusDocument } from "./sprint.js";

export interface RecoveryPoint {
  status: "resume" | "recover" | "complete";
  message: string;
  currentStory?: string | null;
  currentWorkflow?: string | null;
}

export function determineRecoveryPoint(state: RuntimeState, sprint: SprintStatusDocument | undefined): RecoveryPoint {
  if (!sprint) return { status: "recover", message: "Sprint status is missing; rerun sprint planning or restore sprint-status.yaml.", currentStory: state.currentStory, currentWorkflow: state.currentWorkflow };
  const active = sprint.entries.find((entry) => entry.kind === "story" && (entry.status === "in-progress" || entry.status === "review" || entry.status === "ready-for-dev"));
  if (active) return { status: "resume", message: `Resume ${active.key} from sprint status ${active.status}.`, currentStory: active.key, currentWorkflow: state.currentWorkflow };
  const backlog = sprint.entries.find((entry) => entry.kind === "story" && entry.status === "backlog");
  if (backlog) return { status: "resume", message: `Create next backlog story ${backlog.key}.`, currentStory: backlog.key, currentWorkflow: "bmad-create-story" };
  return { status: "complete", message: "No active or backlog stories remain." };
}
