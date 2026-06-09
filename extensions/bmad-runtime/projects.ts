import {
  loadRegistry,
  resolveRegistryPath,
  type ProjectRegistryRecord,
  type RegistryOptions,
  type RegistryOperationError,
} from "./registry.js";

export interface RuntimeProjectsOptions {
  now?: () => number;
  slowThresholdMs?: number;
  listLimit?: number;
  registryOptions?: RegistryOptions;
  detailSelector?: string;
}

export interface RuntimeProjectsReport {
  registryPath: string;
  projects: ProjectRegistryRecord[];
  selectedProject?: ProjectRegistryRecord;
  detailSelector?: string;
  detailError?: string;
  registryError?: RegistryOperationError;
  durationMs: number;
  slowThresholdMs: number;
  writeOccurred: false;
  text: string;
}

function dash(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : "-";
}

function safeRegistryPath(options: RegistryOptions | undefined): string {
  try {
    return resolveRegistryPath(options ?? {});
  } catch (error) {
    return `unresolved (${error instanceof Error ? error.message : String(error)})`;
  }
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortProjects(projects: ProjectRegistryRecord[]): ProjectRegistryRecord[] {
  return [...projects].sort((a, b) => {
    const time = timestampMs(b.lastSeenAt) - timestampMs(a.lastSeenAt);
    if (time !== 0) return time;
    return a.displayName.localeCompare(b.displayName);
  });
}

function compactList(values: string[] | undefined, max = 2): string {
  const clean = (values ?? []).map((item) => item.trim()).filter(Boolean);
  if (clean.length === 0) return "-";
  const shown = clean.slice(0, max).join("; ");
  return clean.length > max ? `${shown}; +${clean.length - max} more` : shown;
}

function projectStatus(project: ProjectRegistryRecord): string {
  const phaseStatus = [project.phase, project.status].filter((item): item is string => !!item && item.trim().length > 0).join(" / ");
  return phaseStatus || "status unknown";
}

function projectListLine(index: number, project: ProjectRegistryRecord): string {
  return [
    `${index}. ${project.displayName}`,
    `status: ${projectStatus(project)}`,
    `roots: ${compactList(project.knownRoots)}`,
    `last seen: ${dash(project.lastSeenAt)}`,
  ].join(" - ");
}

function normalizeSelector(selector: string): string {
  return selector.trim().toLowerCase();
}

function selectorAliases(project: ProjectRegistryRecord): string[] {
  return [
    project.projectId,
    project.displayName,
    ...(project.historicalAliases ?? []),
    ...(project.pathAliases ?? []),
  ].filter(Boolean);
}

function selectProject(projects: ProjectRegistryRecord[], selector: string | undefined): { project?: ProjectRegistryRecord; error?: string } {
  const trimmed = selector?.trim();
  if (!trimmed) return {};

  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed);
    const project = projects[index - 1];
    return project ? { project } : { error: `No project exists at list number ${index}.` };
  }

  const normalized = normalizeSelector(trimmed);
  const exact = projects.filter((project) =>
    selectorAliases(project).some((alias) => normalizeSelector(alias) === normalized),
  );
  if (exact.length === 1) return { project: exact[0] };
  if (exact.length > 1) return { error: `Selector '${trimmed}' matches multiple projects exactly. Use the list number or Stable ID.` };

  const partial = projects.filter((project) => project.displayName.toLowerCase().includes(normalized));
  if (partial.length === 1) return { project: partial[0] };
  if (partial.length > 1) return { error: `Selector '${trimmed}' is ambiguous. Use the list number or Stable ID.` };
  return { error: `No project matched '${trimmed}'. Use /bmad projects for the numbered list.` };
}

function gitEvidenceLines(project: ProjectRegistryRecord): string[] {
  const git = project.gitEvidence;
  if (!git) return ["- none"];
  return [
    `- Worktree: ${dash(git.worktreePath)}`,
    `- Branch: ${dash(git.branch)}`,
    `- Commit: ${dash(git.commit)}`,
    `- Remote fingerprint: ${dash(git.remoteUrlFingerprint)}`,
  ];
}

function targetRepoLines(project: ProjectRegistryRecord): string[] {
  const repos = project.targetRepos ?? [];
  return repos.length
    ? repos.map((repo) => `- ${repo.role}: ${repo.path}`)
    : ["- none"];
}

function projectDetailsLines(project: ProjectRegistryRecord): string[] {
  return [
    "## Project Details",
    "",
    `- Name: ${project.displayName}`,
    `- Stable ID: ${project.projectId}`,
    `- Phase: ${dash(project.phase)}`,
    `- Status: ${dash(project.status)}`,
    `- Current workflow: ${dash(project.currentWorkflow)}`,
    `- Current story: ${dash(project.currentStory)}`,
    `- Last workflow: ${dash(project.lastWorkflow)}`,
    `- Readiness: ${dash(project.readinessState)}`,
    `- Active version: ${dash(project.activeVersion)}`,
    `- Last seen: ${dash(project.lastSeenAt)}`,
    `- Artifact root: ${dash(project.artifactRoot)}`,
    `- Runtime state: ${dash(project.runtimeStatePath)}`,
    `- Known roots: ${compactList(project.knownRoots, 10)}`,
    `- Path aliases: ${compactList(project.pathAliases, 10)}`,
    `- Historical aliases: ${compactList(project.historicalAliases, 10)}`,
    "",
    "### Git Evidence",
    "",
    ...gitEvidenceLines(project),
    "",
    "### Target Repos",
    "",
    ...targetRepoLines(project),
  ];
}

export function parseProjectsArgs(rest: string[]): { detailSelector?: string } {
  const [first = "", ...tail] = rest;
  if (!first) return {};
  if (["details", "detail", "show", "--details"].includes(first)) {
    const detailSelector = tail.join(" ").trim();
    return detailSelector ? { detailSelector } : {};
  }
  const detailSelector = rest.join(" ").trim();
  return detailSelector ? { detailSelector } : {};
}

export async function buildRuntimeProjectsReport(_cwd: string, options: RuntimeProjectsOptions = {}): Promise<RuntimeProjectsReport> {
  const now = options.now ?? Date.now;
  const started = now();
  const slowThresholdMs = options.slowThresholdMs ?? 2000;
  const listLimit = Math.max(1, options.listLimit ?? 50);
  const registryPath = safeRegistryPath(options.registryOptions);
  const registry = await loadRegistry(options.registryOptions ?? {});
  const durationMs = Math.max(0, now() - started);

  if (!registry.ok) {
    const text = [
      "# BMAD Projects",
      "",
      `Projects duration: ${durationMs}ms`,
      "Write occurred: false",
      `Registry: ${registryPath}`,
      "",
      "## Registry Unavailable",
      "",
      `- Code: ${registry.error.code}`,
      `- Error: ${registry.error.message}`,
      `- Recovery: ${registry.error.recoveryAction.action}`,
      `- Reason: ${registry.error.recoveryAction.reason}`,
      "",
      "Next safe action: run `/bmad-start` in the intended BMAD workspace, or repair Runtime Home registry metadata, then retry `/bmad projects`.",
    ].join("\n");
    return {
      registryPath,
      projects: [],
      registryError: registry.error,
      durationMs,
      slowThresholdMs,
      writeOccurred: false,
      text,
    };
  }

  const projects = sortProjects(registry.value.projects);
  const visibleProjects = projects.slice(0, listLimit);
  const selection = selectProject(projects, options.detailSelector);
  const lines = [
    "# BMAD Projects",
    "",
    `Projects duration: ${durationMs}ms`,
    "Write occurred: false",
    `Registry: ${registryPath}`,
    `Registry updated: ${dash(registry.value.updatedAt)}`,
    `Project count: ${projects.length}`,
    `Showing: ${visibleProjects.length}/${projects.length}`,
    ...(durationMs > slowThresholdMs
      ? [`Performance note: projects exceeded ${slowThresholdMs}ms while reading registry metadata; no registry, artifact, or state writes occurred.`]
      : []),
    ...(projects.length >= 100
      ? [`Large registry note: listed ${projects.length} projects from metadata only; use \`/bmad projects details <number|name|projectId>\` for details on demand.`]
      : []),
    "",
    "## Registered Projects",
    "",
    ...(visibleProjects.length ? visibleProjects.map((project, index) => projectListLine(index + 1, project)) : ["No registered BMAD projects found."]),
    ...(projects.length > visibleProjects.length
      ? [`... ${projects.length - visibleProjects.length} more projects hidden to keep context compact. Use details by name or Stable ID.`]
      : []),
    "",
    "Details: `/bmad projects details <number|name|projectId>`",
    "Selection/creation remains conversational through `/bmad-start` or `/bmad start`.",
  ];

  if (options.detailSelector) {
    lines.push("", `Requested details: ${options.detailSelector}`);
    if (selection.project) lines.push("", ...projectDetailsLines(selection.project));
    else lines.push("", "## Project Details", "", `- Error: ${selection.error ?? "No detail selector provided."}`);
  }

  return {
    registryPath,
    projects,
    selectedProject: selection.project,
    detailSelector: options.detailSelector,
    detailError: selection.error,
    durationMs,
    slowThresholdMs,
    writeOccurred: false,
    text: lines.join("\n"),
  };
}

export function formatRuntimeProjectsReport(report: RuntimeProjectsReport): string {
  return report.text;
}
