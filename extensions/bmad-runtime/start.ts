import * as fs from "node:fs";
import * as path from "node:path";
import { loadPathConfig, toProjectRelative } from "./paths.js";
import { buildPhase3AutomationPlan, buildPhase3ResumeState, formatPhase3AutomationPlan, formatPhase3ResumeState, isPhase3ResumeApplicable, validatePhase3ResumeState } from "./phase3.js";
import { buildPhase4AutomationContext, buildPhase4AutomationExecutionPlan, formatPhase4AutomationRecommendation, recommendPhase4Automation } from "./phase4-automation.js";
import { buildPhase4ResumeState, formatPhase4ResumeState, isPhase4ResumeApplicable, validatePhase4ResumeState } from "./phase4.js";
import type { ProjectResolutionResult } from "./resolution.js";
import type { ProjectRegistryRecord } from "./registry.js";
import { shouldActivateResolvedProject } from "./resolution.js";
import { loadSprintStatus } from "./sprint.js";
import { summarizeStateForSession, type RuntimeState } from "./state.js";

export interface StartNewArgs {
  projectName: string;
  rootPreference?: string;
  localVersioning?: "init" | "skip";
  error?: string;
}

export interface ProjectHandoff {
  path: string;
  relativePath: string;
  updatedAt: string;
  bytes: number;
  excerpt: string;
}

export interface StartProjectOption {
  index: number;
  projectId: string;
  displayName: string;
  workspacePath?: string;
  previousWorkspacePath?: string;
  requiresRebind?: boolean;
  requiresVariantChoice?: boolean;
  phase?: string;
  currentWorkflow?: string | null;
  currentStory?: string | null;
  lastSeenAt?: string;
}

export type StartRouterReply =
  | { action: "continue"; option: StartProjectOption }
  | { action: "new"; projectName?: string }
  | { action: "unknown" };

const HANDOFF_FILE_LIMIT = 128;
const HANDOFF_EXCERPT_BYTES = 6 * 1024;
const HANDOFF_MAX_DEPTH = 4;

function startNewArgs(input: StartNewArgs): StartNewArgs {
  const out: StartNewArgs = { projectName: input.projectName };
  if (input.rootPreference) out.rootPreference = input.rootPreference;
  if (input.localVersioning) out.localVersioning = input.localVersioning;
  if (input.error) out.error = input.error;
  return out;
}

export function parseStartNewArgs(parts: string[]): StartNewArgs {
  const nameParts: string[] = [];
  let rootPreference: string | undefined;
  let localVersioning: "init" | "skip" | undefined;
  for (let index = 0; index < parts.length; index++) {
    const token = parts[index];
    if (!token) continue;
    if (token === "--git-init") {
      localVersioning = "init";
      continue;
    }
    if (token === "--no-git-init" || token === "--skip-git-init") {
      localVersioning = "skip";
      continue;
    }
    if (token === "--root") {
      if (!parts[index + 1] || parts[index + 1]!.startsWith("--")) {
        return startNewArgs({ projectName: nameParts.join(" ").trim(), localVersioning, error: "--root requires a path value" });
      }
      rootPreference = parts[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith("--")) continue;
    nameParts.push(token);
  }
  return startNewArgs({ projectName: nameParts.join(" ").trim(), rootPreference, localVersioning });
}

export function parseStartNewText(text: string): StartNewArgs {
  const trimmed = text.trim();
  if (!trimmed) return { projectName: "" };
  const parts = Array.from(trimmed.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g))
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
    .filter(Boolean);
  return parseStartNewArgs(parts);
}

function isLikelyHandoffFile(file: string): boolean {
  const name = path.basename(file).toLowerCase();
  return name.endsWith(".md") && (name.includes("handoff") || name.includes("bootstrap") || name.includes("resume"));
}

function collectCandidateFiles(root: string, out: string[], depth = 0): void {
  if (out.length >= HANDOFF_FILE_LIMIT || depth > HANDOFF_MAX_DEPTH || !fs.existsSync(root)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= HANDOFF_FILE_LIMIT) return;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      collectCandidateFiles(full, out, depth + 1);
      continue;
    }
    if (entry.isFile() && isLikelyHandoffFile(full)) out.push(full);
  }
}

function readExcerpt(file: string): string {
  const buffer = fs.readFileSync(file);
  return buffer.subarray(0, HANDOFF_EXCERPT_BYTES).toString("utf8").trim();
}

export function findLatestProjectHandoff(cwd: string): ProjectHandoff | undefined {
  const cfg = loadPathConfig(cwd);
  const roots = [
    path.join(cwd, ".bmad-runtime"),
    path.join(cwd, ".bmad-runtime", "handoffs"),
    cfg.output_folder,
    path.join(cfg.output_folder, "evidence"),
    path.join(cfg.output_folder, "handoffs"),
  ];
  const candidates: string[] = [];
  for (const root of roots) collectCandidateFiles(root, candidates);
  const unique = [...new Set(candidates)];
  const latest = unique
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        return stat.isFile() ? { file, stat } : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((item): item is { file: string; stat: fs.Stats } => !!item)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
  if (!latest) return undefined;
  return {
    path: latest.file,
    relativePath: toProjectRelative(cwd, latest.file),
    updatedAt: latest.stat.mtime.toISOString(),
    bytes: latest.stat.size,
    excerpt: readExcerpt(latest.file),
  };
}

function workspacePathFromRecord(project: ProjectRegistryRecord): string | undefined {
  const knownRoot = project.knownRoots?.find(Boolean);
  if (knownRoot) return knownRoot;
  const absoluteAlias = project.pathAliases?.find((item) => path.isAbsolute(item));
  if (absoluteAlias) return absoluteAlias;
  if (project.runtimeStatePath) return path.dirname(path.dirname(project.runtimeStatePath));
  return undefined;
}

function optionFromCandidate(index: number, candidate: ProjectResolutionResult["candidates"][number]): StartProjectOption {
  return {
    index,
    projectId: candidate.projectId,
    displayName: candidate.displayName,
    workspacePath: candidate.canonicalPaths.knownRoots[0] ?? candidate.canonicalPaths.pathAliases.find((item) => path.isAbsolute(item)),
    phase: candidate.phase,
    currentWorkflow: candidate.currentWorkflow,
    currentStory: candidate.currentStory,
    lastSeenAt: candidate.lastSeenAt,
  };
}

function optionFromRecord(index: number, project: ProjectRegistryRecord): StartProjectOption {
  return {
    index,
    projectId: project.projectId,
    displayName: project.displayName,
    workspacePath: workspacePathFromRecord(project),
    phase: project.phase,
    currentWorkflow: project.currentWorkflow,
    currentStory: project.currentStory,
    lastSeenAt: project.lastSeenAt,
  };
}

export function buildStartProjectOptions(result: ProjectResolutionResult, registryProjects: ProjectRegistryRecord[] = []): StartProjectOption[] {
  const byId = new Map<string, StartProjectOption>();
  const candidates = [
    ...(result.selectedProject ? [result.selectedProject] : []),
    ...result.candidates,
    ...result.rejectedCandidates,
  ];
  for (const candidate of candidates) {
    if (!byId.has(candidate.projectId)) {
      const option = optionFromCandidate(byId.size + 1, candidate);
      if (result.confidence === "needs_rebind" && result.selectedProjectId === candidate.projectId) {
        option.requiresRebind = true;
        option.previousWorkspacePath = option.workspacePath;
        option.workspacePath = result.canonicalPaths.cwd;
      }
      if (result.confidence === "variant_choice_required" && result.selectedProjectId === candidate.projectId) {
        option.requiresVariantChoice = true;
        option.workspacePath = result.canonicalPaths.cwd;
      }
      byId.set(candidate.projectId, option);
    }
  }
  for (const project of registryProjects) {
    if (!byId.has(project.projectId)) byId.set(project.projectId, optionFromRecord(byId.size + 1, project));
  }
  return [...byId.values()].map((option, index) => ({ ...option, index: index + 1 }));
}

function normalizeChoiceText(text: string): string {
  return text.trim().toLowerCase();
}

function stripNewProjectPrefix(text: string): string | undefined {
  const trimmed = text.trim();
  const match = trimmed.match(/^(?:novo|nova|new|criar|começar|comecar|start new|new project)\s+(.+)$/i);
  return match?.[1]?.trim();
}

export function parseStartRouterReply(text: string, options: StartProjectOption[]): StartRouterReply {
  const normalized = normalizeChoiceText(text);
  if (!normalized) return { action: "unknown" };
  const newProjectName = stripNewProjectPrefix(text);
  if (newProjectName) return { action: "new", projectName: newProjectName };
  if (["novo", "nova", "new", "criar novo", "criar um novo", "projeto novo", "novo projeto"].includes(normalized)) {
    return { action: "new" };
  }
  const numeric = normalized.match(/^\d+$/)?.[0];
  if (numeric) {
    const index = Number(numeric);
    const option = options.find((item) => item.index === index);
    if (option) return { action: "continue", option };
    return index === options.length + 1 ? { action: "new" } : { action: "unknown" };
  }
  const exact = options.find((option) =>
    option.projectId.toLowerCase() === normalized ||
    option.displayName.toLowerCase() === normalized,
  );
  if (exact) return { action: "continue", option: exact };
  const partialMatches = options.filter((option) => option.displayName.toLowerCase().includes(normalized));
  return partialMatches.length === 1 ? { action: "continue", option: partialMatches[0]! } : { action: "unknown" };
}

function formatOption(option: StartProjectOption): string {
  const anchor = [option.phase, option.currentWorkflow, option.currentStory].filter(Boolean).join(" / ") || "state unknown";
  if (option.requiresRebind) {
    const previous = option.previousWorkspacePath ? `; previous: ${option.previousWorkspacePath}` : "";
    const workspace = option.workspacePath ? ` - current: ${option.workspacePath}` : "";
    return `${option.index}. Confirm rebind and continue: ${option.displayName} (${anchor})${workspace}${previous}`;
  }
  if (option.requiresVariantChoice) {
    const workspace = option.workspacePath ? ` - current variant: ${option.workspacePath}` : "";
    return `${option.index}. Use current git variant and continue: ${option.displayName} (${anchor})${workspace}`;
  }
  const workspace = option.workspacePath ? ` - ${option.workspacePath}` : "";
  return `${option.index}. Continue: ${option.displayName} (${anchor})${workspace}`;
}

function projectChoiceLines(result: ProjectResolutionResult, handoff: ProjectHandoff | undefined, options: StartProjectOption[]): string[] {
  const selected = result.selectedProject ?? result.localWorkspace;
  const newIndex = options.length + 1;
  if (shouldActivateResolvedProject(result)) {
    return [
      "## Choices",
      "",
      ...(options.length ? options.map(formatOption) : [`1. Continue current BMAD workspace: ${selected ? `${selected.displayName} (${selected.projectId})` : "current BMAD workspace"}`]),
      `   Bootstrap source: ${handoff ? handoff.relativePath : "runtime state + status; no handoff file found"}`,
      `${newIndex}. Start a new dedicated BMAD project workspace (optional: add --git-init or --no-git-init after the project name)`,
    ];
  }
  if (result.confidence === "ambiguous") {
    return [
      "## Choices",
      "",
      ...(options.length ? options.map(formatOption) : ["No registered projects found."]),
      `${newIndex}. Start a new dedicated BMAD project workspace (optional: add --git-init or --no-git-init after the project name)`,
    ];
  }
  if (result.confidence === "local_workspace_unregistered" && result.reconcileAllowed) {
    return [
      "## Existing Workspace Found",
      "",
      "1. Register this local BMAD workspace and continue it",
      `${newIndex}. Start a new dedicated BMAD project workspace instead (optional: add --git-init or --no-git-init after the project name)`,
    ];
  }
  if (result.confidence === "needs_rebind") {
    return [
      "## Moved Workspace Found",
      "",
      ...(options.length ? options.map(formatOption) : ["No rebind candidate found."]),
      `${newIndex}. Start a new dedicated BMAD project workspace instead (optional: add --git-init or --no-git-init after the project name)`,
    ];
  }
  if (result.confidence === "variant_choice_required") {
    return [
      "## Git Variant Choice Required",
      "",
      ...(options.length ? options.map(formatOption) : ["No variant candidate found."]),
      `${newIndex}. Start a new dedicated BMAD project workspace instead (optional: add --git-init or --no-git-init after the project name)`,
    ];
  }
  if (result.confidence === "new_project_intent_required") {
    return [
      "## Explicit Intent Required",
      "",
      "1. Use this current git repo as the BMAD project workspace",
      `${newIndex}. Start a new dedicated BMAD project workspace outside this repo (optional: add --git-init or --no-git-init after the project name)`,
    ];
  }
  return [
    "## Start Blocked",
    "",
    `Next safe action: ${result.nextSafeAction}`,
    "",
    "The agent should explain why this folder is unsafe and ask where the intended BMAD project workspace is.",
  ];
}

export function buildStartMenu(cwd: string, result: ProjectResolutionResult, state: RuntimeState, handoff = findLatestProjectHandoff(cwd), options = buildStartProjectOptions(result)): string {
  return [
    "# BMAD Start",
    "",
    "The agent will ask whether to continue an existing BMAD project or start a new one. The user should not need to memorize subcommands.",
    "",
    ...projectChoiceLines(result, handoff, options),
    "",
    "## Current Project Resolution",
    "",
    `- Confidence: ${result.confidence}`,
    `- Reason: ${result.reason}`,
    `- Next safe action: ${result.nextSafeAction}`,
    "",
    "## Runtime State Summary",
    "",
    "```json",
    JSON.stringify(summarizeStateForSession(state), null, 2),
    "```",
  ].join("\n");
}

export function buildStartRouterPrompt(cwd: string, result: ProjectResolutionResult, state: RuntimeState, handoff = findLatestProjectHandoff(cwd), options = buildStartProjectOptions(result)): string {
  return `/skill:bmad-runtime-for-pi start router

You are starting BMAD Runtime for Pi. The user invoked a single start command and should not need to know internal subcommands.

Ask one concise question in the user's language: should we continue one of the existing BMAD projects below, or start a new project?

${buildStartMenu(cwd, result, state, handoff, options)}

Rules:
1. Present the choices by project name, phase, current workflow/story when available.
2. If the user chooses an existing project, confirm the project anchor and continue/resume it from runtime state plus latest handoff.
3. If the user chooses a new project, ask for the project name plus optional preferred root folder and optional local versioning choice (--git-init or --no-git-init), then create a dedicated workspace through the runtime.
4. Use the Pi agent and BMAD Runtime as the product model; do not introduce unrelated forks, adapters, or named personas.
5. Keep the first response short. Do not dump BMAD documentation.`;
}

export function buildContinuationBootstrapPrompt(cwd: string, result: ProjectResolutionResult, state: RuntimeState, handoff = findLatestProjectHandoff(cwd)): string {
  const selected = result.selectedProject ?? result.localWorkspace;
  const summary = summarizeStateForSession(state);
  const phase3 = isPhase3ResumeApplicable(state) ? buildPhase3ResumeState(cwd, state) : undefined;
  const phase3Block = phase3
    ? formatPhase3ResumeState(phase3, validatePhase3ResumeState(cwd, phase3))
    : undefined;
  const phase3PlanBlock = phase3
    ? formatPhase3AutomationPlan(buildPhase3AutomationPlan(cwd, state))
    : undefined;
  const phase4 = isPhase4ResumeApplicable(state) ? buildPhase4ResumeState(cwd, state) : undefined;
  const phase4Block = phase4
    ? formatPhase4ResumeState(phase4, validatePhase4ResumeState(cwd, phase4))
    : undefined;
  const cfg = loadPathConfig(cwd);
  const sprint = loadSprintStatus(cfg);
  const phase4Automation = state.phase === "4-implementation" && sprint.doc
    ? recommendPhase4Automation(sprint.doc, cfg, buildPhase4AutomationContext(cwd, cfg))
    : undefined;
  const phase4AutomationBlock = phase4Automation
    ? phase4Automation.action === "complete"
      ? [
        "## Phase 4 Complete",
        "",
        "Phase 4 story automation is complete. After release/install smoke and handoff evidence are captured, set `/bmad phase 5-ready-for-use`.",
        "",
        formatPhase4AutomationRecommendation(phase4Automation),
      ].join("\n")
      : [
        "## Phase 4 Automatic Next Step",
        "",
        formatPhase4AutomationRecommendation(phase4Automation),
        "",
        "Execution plan:",
        "",
        "```text",
        buildPhase4AutomationExecutionPlan(phase4Automation).prompt,
        "```",
      ].join("\n")
    : undefined;
  const handoffBlock = handoff
    ? [
        "## Latest Handoff",
        "",
        `Path: ${handoff.relativePath}`,
        `Updated at: ${handoff.updatedAt}`,
        "",
        "Excerpt:",
        "",
        "```md",
        handoff.excerpt,
        "```",
      ].join("\n")
    : [
        "## Latest Handoff",
        "",
        "No handoff/bootstrap file was found. Use runtime state, `/bmad status`, sprint status, and canonical artifacts as source of truth.",
      ].join("\n");
  return `/skill:bmad-runtime-for-pi resume existing-project

You are resuming an existing BMAD Runtime project in Pi.

## Project Anchor

- Project: ${selected ? `${selected.displayName} (${selected.projectId})` : "resolved local project"}
- Workspace: ${cwd}
- Resolution confidence: ${result.confidence}
- Current phase: ${summary.phase}
- Current mode: ${summary.mode}
- Current workflow: ${summary.currentWorkflow ?? "none"}
- Current story: ${summary.currentStory ?? "none"}
- Last run: ${summary.lastRun ? `${summary.lastRun.skill} at ${summary.lastRun.launchedAt}` : "none"}

${handoffBlock}

${phase3Block ? `${phase3Block}\n` : ""}
${phase3PlanBlock ? `${phase3PlanBlock}\n` : ""}
${phase4Block ? `${phase4Block}\n` : ""}
${phase4AutomationBlock ? `${phase4AutomationBlock}\n` : ""}

## Resume Rules

1. Treat this workspace identity and runtime state as authoritative. Do not mix this project with another BMAD project or with the runtime package repository.
2. Keep context lean: read only the handoff excerpt first; inspect full artifacts only when they are needed for the next action.
3. Run or mentally apply /bmad status before changing files if state/artifacts disagree.
4. If Phase 1/2, continue the interview only where human judgement is needed; routine confirmations should be compressed into clear recommendations.
5. If Phase 3/4, continue autonomously through the next BMAD workflow unless a blocker from the autonomy contract appears.
6. If Phase 5, do not resume Phase 4 story automation unless a new version/story/incident/support task is explicit.
7. Do not ask the user to run a separate automation command; \`/bmad-start\` and this resume bootstrap are the normal automation driver.
8. Preserve canonical engine/workflow artifacts; consumer-project task docs may be treated as ephemeral only after their result is captured in sprint/status/evidence.
9. Report the current BMAD anchor before acting: project, phase, workflow, story, and next required step.`;
}
