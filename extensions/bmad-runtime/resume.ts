import * as fs from "node:fs";
import * as path from "node:path";
import { describeRuntimeBoundaries } from "./boundaries.js";
import { loadPathConfig } from "./paths.js";
import {
  loadRegistry,
  resolveRegistryPath,
  type ProjectRegistryRecord,
  type RegistryOptions,
  type RegistryOperationError,
} from "./registry.js";
import { getProjectIdentityFile } from "./project.js";
import { type ProjectResolutionResult, type ResolutionCandidate, type ResolutionEvidence } from "./resolution.js";
import { loadState, type RuntimeState } from "./state.js";

export interface ResumeProjectOptions {
  registryOptions?: RegistryOptions;
}

export type ResumeProjectStatus = "ready" | "ambiguous" | "blocked";

export interface ResumeProjectResult {
  status: ResumeProjectStatus;
  selector: string;
  registryPath: string;
  writeOccurred: false;
  project?: ProjectRegistryRecord;
  matches: ProjectRegistryRecord[];
  workspacePath?: string;
  state?: RuntimeState;
  reason: string;
  recoveryAction?: string;
  registryError?: RegistryOperationError;
}

function safeRegistryPath(options: RegistryOptions | undefined): string {
  try {
    return resolveRegistryPath(options ?? {});
  } catch (error) {
    return `unresolved (${error instanceof Error ? error.message : String(error)})`;
  }
}

function clean(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function normalize(value: string): string {
  return clean(value).toLowerCase();
}

function aliases(project: ProjectRegistryRecord): string[] {
  return [
    project.projectId,
    project.displayName,
    ...(project.historicalAliases ?? []),
    ...(project.pathAliases ?? []),
  ].filter((item) => item.trim().length > 0);
}

function uniqueProjects(projects: ProjectRegistryRecord[]): ProjectRegistryRecord[] {
  const seen = new Set<string>();
  return projects.filter((project) => {
    if (seen.has(project.projectId)) return false;
    seen.add(project.projectId);
    return true;
  });
}

function findMatches(projects: ProjectRegistryRecord[], selector: string): ProjectRegistryRecord[] {
  const target = normalize(selector);
  const exact = projects.filter((project) => aliases(project).some((alias) => normalize(alias) === target));
  if (exact.length > 0) return uniqueProjects(exact);
  return uniqueProjects(projects.filter((project) =>
    [project.displayName, ...(project.historicalAliases ?? [])].some((alias) => normalize(alias).includes(target)),
  ));
}

function firstExistingDirectory(values: string[]): string | undefined {
  return values.find((value) => {
    try {
      return value.trim().length > 0 && fs.existsSync(value) && fs.statSync(value).isDirectory();
    } catch {
      return false;
    }
  });
}

function workspaceFor(project: ProjectRegistryRecord): string | undefined {
  const candidates = [...(project.knownRoots ?? []), ...(project.pathAliases ?? [])].filter((item) => item.trim().length > 0);
  return firstExistingDirectory(candidates) ?? candidates[0];
}

function nextStepFromState(state: RuntimeState): string {
  if (state.currentWorkflow && state.currentStory) return `Continue ${state.currentWorkflow} for story ${state.currentStory}.`;
  if (state.currentWorkflow) return `Continue ${state.currentWorkflow}.`;
  if (state.phase === "1-analysis" || state.phase === "2-planning") return "Resume the human-in-loop BMAD interview/planning workflow.";
  return "Run /bmad status in the resumed project and continue from the runtime recommendation.";
}

function pickerLine(project: ProjectRegistryRecord, index: number): string {
  const anchor = [project.phase, project.status, project.currentWorkflow, project.currentStory].filter(Boolean).join(" / ") || "state unknown";
  return `${index}. ${project.displayName} (${project.projectId}) - ${anchor}`;
}

export async function resolveResumeProject(selector: string, options: ResumeProjectOptions = {}): Promise<ResumeProjectResult> {
  const cleanSelector = clean(selector);
  const registryPath = safeRegistryPath(options.registryOptions);
  if (!cleanSelector) {
    return {
      status: "blocked",
      selector: cleanSelector,
      registryPath,
      writeOccurred: false,
      matches: [],
      reason: "Resume requires a Stable ID, project name, or alias.",
      recoveryAction: "run-bmad-projects-then-resume-with-id-name-or-alias",
    };
  }

  const registry = await loadRegistry(options.registryOptions ?? {});
  if (!registry.ok) {
    return {
      status: "blocked",
      selector: cleanSelector,
      registryPath,
      writeOccurred: false,
      matches: [],
      registryError: registry.error,
      reason: `Registry could not be loaded: ${registry.error.message}`,
      recoveryAction: registry.error.recoveryAction.action,
    };
  }

  const matches = findMatches(registry.value.projects, cleanSelector);
  if (matches.length === 0) {
    return {
      status: "blocked",
      selector: cleanSelector,
      registryPath,
      writeOccurred: false,
      matches: [],
      reason: `No registered BMAD project matched '${cleanSelector}'.`,
      recoveryAction: "run-bmad-projects-and-retry-with-stable-id",
    };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      selector: cleanSelector,
      registryPath,
      writeOccurred: false,
      matches,
      reason: `Selector '${cleanSelector}' matched ${matches.length} projects. Choose one before any write.`,
      recoveryAction: "rerun-bmad-resume-with-stable-id-from-picker",
    };
  }

  const project = matches[0]!;
  const workspacePath = workspaceFor(project);
  if (!workspacePath || !fs.existsSync(workspacePath)) {
    return {
      status: "blocked",
      selector: cleanSelector,
      registryPath,
      writeOccurred: false,
      project,
      matches,
      workspacePath,
      reason: `Resolved project '${project.displayName}' but its workspace path is unavailable.`,
      recoveryAction: "repair-known-root-or-rebind-project-before-resume",
    };
  }
  if (!fs.existsSync(project.runtimeStatePath)) {
    return {
      status: "blocked",
      selector: cleanSelector,
      registryPath,
      writeOccurred: false,
      project,
      matches,
      workspacePath,
      reason: `Resolved project '${project.displayName}' but runtime state is missing: ${project.runtimeStatePath}`,
      recoveryAction: "repair-project-runtime-state-before-resume",
    };
  }

  return {
    status: "ready",
    selector: cleanSelector,
    registryPath,
    writeOccurred: false,
    project,
    matches,
    workspacePath,
    state: loadState(workspacePath),
    reason: `Selector '${cleanSelector}' resolved to '${project.displayName}' (${project.projectId}) without using current cwd.`,
  };
}

function evidence(project: ProjectRegistryRecord, workspacePath: string): ResolutionEvidence[] {
  return [
    { kind: "registry", label: "resume selector matched registry metadata", value: project.displayName, projectId: project.projectId },
    { kind: "registry", label: "Stable ID", value: project.projectId, projectId: project.projectId },
    { kind: "cwd", label: "resume workspace from registry known roots", value: workspacePath, path: workspacePath, projectId: project.projectId },
  ];
}

function candidateFromProject(project: ProjectRegistryRecord): ResolutionCandidate {
  return {
    projectId: project.projectId,
    displayName: project.displayName,
    historicalAliases: project.historicalAliases ?? [],
    score: 100,
    matchedBy: [],
    phase: project.phase,
    status: project.status,
    currentWorkflow: project.currentWorkflow,
    currentStory: project.currentStory,
    lastSeenAt: project.lastSeenAt,
    gitEvidence: project.gitEvidence,
    canonicalPaths: {
      knownRoots: project.knownRoots ?? [],
      artifactRoot: project.artifactRoot,
      runtimeStatePath: project.runtimeStatePath,
      pathAliases: project.pathAliases ?? [],
    },
  };
}

export function buildResumeProjectResolution(result: ResumeProjectResult): ProjectResolutionResult {
  if (result.status !== "ready" || !result.project || !result.workspacePath) {
    throw new Error("Resume project resolution requires a ready result.");
  }
  const cfg = loadPathConfig(result.workspacePath);
  const selectedProject = candidateFromProject(result.project);
  return {
    confidence: "unique_confident",
    selectedProjectId: result.project.projectId,
    selectedProject,
    candidates: [selectedProject],
    evidenceUsed: evidence(result.project, result.workspacePath),
    rejectedCandidates: [],
    reason: result.reason,
    nextSafeAction: result.state ? nextStepFromState(result.state) : "Load project runtime state and continue.",
    writeAllowed: true,
    writeOccurred: false,
    canonicalPaths: {
      cwd: result.workspacePath,
      projectWorkspace: result.workspacePath,
      outputFolder: cfg.output_folder,
      planningArtifacts: cfg.planning_artifacts,
      implementationArtifacts: cfg.implementation_artifacts,
      projectKnowledge: cfg.project_knowledge,
      runtimeStatePath: result.project.runtimeStatePath,
      projectIdentityPath: getProjectIdentityFile(result.workspacePath),
      registryPath: result.registryPath,
    },
    boundaries: describeRuntimeBoundaries(result.workspacePath),
  };
}

export function formatResumeProjectResult(result: ResumeProjectResult, options: { writeOccurred?: boolean; handoffPath?: string } = {}): string {
  const writeOccurred = options.writeOccurred === true;
  const lines = [
    "# BMAD Resume",
    "",
    `Status: ${result.status}`,
    `Selector: ${result.selector || "-"}`,
    `Write occurred: ${writeOccurred}`,
    `Registry: ${result.registryPath}`,
    `Reason: ${result.reason}`,
  ];
  if (result.recoveryAction) lines.push(`Recovery: ${result.recoveryAction}`);
  if (result.registryError) lines.push(`Registry error: ${result.registryError.code}`);

  if (result.status === "ambiguous") {
    lines.push(
      "",
      "## Resume Picker",
      "",
      ...result.matches.map(pickerLine),
      "",
      "No project state, registry, artifact, or workspace write occurred.",
      "Rerun `/bmad resume <Stable ID>` with one item from the picker.",
    );
    return lines.join("\n");
  }

  if (result.status === "ready" && result.project && result.workspacePath && result.state) {
    lines.push(
      "",
      "## Resolved Project",
      "",
      `- Project: ${result.project.displayName} (${result.project.projectId})`,
      `- Workspace: ${result.workspacePath}`,
      `- Phase: ${result.state.phase}`,
      `- Mode: ${result.state.mode}`,
      `- Current workflow: ${result.state.currentWorkflow ?? "none"}`,
      `- Current story: ${result.state.currentStory ?? "none"}`,
      `- Next step: ${nextStepFromState(result.state)}`,
      options.handoffPath ? `- Handoff: ${options.handoffPath}` : "- Handoff: not written",
      "",
      "## Canonical Paths",
      "",
      `- Project Workspace: ${result.workspacePath}`,
      `- Artifact root: ${result.project.artifactRoot}`,
      `- Runtime state: ${result.project.runtimeStatePath}`,
      `- Registry: ${result.registryPath}`,
    );
  }

  return lines.join("\n");
}
