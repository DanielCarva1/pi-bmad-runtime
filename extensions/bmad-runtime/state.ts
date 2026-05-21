import * as fs from "node:fs";
import * as path from "node:path";

export type RuntimePhase =
  | "0-init"
  | "1-analysis"
  | "2-planning"
  | "3-solutioning"
  | "4-implementation"
  | "anytime";

export type RuntimeMode = "interview" | "autonomous" | "paused";

export type RuntimeTrack = "undecided" | "quick-flow" | "bmad-method" | "enterprise" | "custom";

export interface ParkingLotItem {
  text: string;
  createdAt: string;
}

export interface RuntimeState {
  version: 1;
  active: boolean;
  mode: RuntimeMode;
  track: RuntimeTrack;
  phase: RuntimePhase;
  currentWorkflow?: string | null;
  currentStory?: string | null;
  autonomy: {
    phase3And4Yolo: boolean;
    askUserOnlyFor: string[];
  };
  createdAt: string;
  updatedAt: string;
  parkingLot: ParkingLotItem[];
}

export const STATE_DIR = ".bmad-runtime";
export const STATE_FILE = "state.json";

export function getStateDir(cwd: string): string {
  return path.join(cwd, STATE_DIR);
}

export function getStateFile(cwd: string): string {
  return path.join(getStateDir(cwd), STATE_FILE);
}

export function createDefaultState(): RuntimeState {
  const now = new Date().toISOString();
  return {
    version: 1,
    active: false,
    mode: "interview",
    track: "undecided",
    phase: "0-init",
    currentWorkflow: null,
    currentStory: null,
    autonomy: {
      phase3And4Yolo: true,
      askUserOnlyFor: [
        "credentials, secrets, or account access",
        "paid external services or API usage not already configured",
        "destructive irreversible actions",
        "legal/compliance/product positioning decisions",
        "contradictions between approved artifacts",
        "new scope outside approved PRD/architecture",
        "dependency installation if not pre-authorized by the project",
      ],
    },
    createdAt: now,
    updatedAt: now,
    parkingLot: [],
  };
}

function normalizeState(raw: unknown): RuntimeState {
  const base = createDefaultState();
  if (!raw || typeof raw !== "object") return base;
  const value = raw as Partial<RuntimeState>;
  return {
    ...base,
    ...value,
    version: 1,
    autonomy: {
      ...base.autonomy,
      ...(value.autonomy ?? {}),
    },
    parkingLot: Array.isArray(value.parkingLot) ? value.parkingLot : [],
  };
}

export function loadState(cwd: string): RuntimeState {
  const file = getStateFile(cwd);
  if (!fs.existsSync(file)) return createDefaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return normalizeState(parsed);
  } catch {
    return createDefaultState();
  }
}

export function saveState(cwd: string, state: RuntimeState): RuntimeState {
  const dir = getStateDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const next: RuntimeState = { ...state, updatedAt: new Date().toISOString() };
  fs.writeFileSync(getStateFile(cwd), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function activateState(state: RuntimeState): RuntimeState {
  return {
    ...state,
    active: true,
    mode: state.mode === "paused" ? "interview" : state.mode,
    phase: state.phase === "0-init" ? "1-analysis" : state.phase,
  };
}

export function deactivateState(state: RuntimeState): RuntimeState {
  return {
    ...state,
    active: false,
    mode: "paused",
    currentWorkflow: null,
  };
}

export function setPhase(state: RuntimeState, phase: RuntimePhase): RuntimeState {
  const mode: RuntimeMode = phase === "3-solutioning" || phase === "4-implementation" ? "autonomous" : "interview";
  return { ...state, phase, mode };
}

export function isAutonomousPhase(state: RuntimeState): boolean {
  return state.phase === "3-solutioning" || state.phase === "4-implementation" || state.mode === "autonomous";
}
