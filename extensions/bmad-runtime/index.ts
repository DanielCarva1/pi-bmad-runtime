import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatPackageAdapters, scanPackageAdapters } from "./adapters.js";
import { formatArtifactRegistry, scanArtifactRegistry } from "./artifacts.js";
import { buildPhase4AutomationContext, formatPhase4AutomationRecommendation, recommendPhase4Automation } from "./phase4-automation.js";
import { describeRuntimeBoundaries, formatRuntimeBoundaries } from "./boundaries.js";
import { findCatalogRow, loadBmadCatalog, type BmadCatalogRow } from "./catalog.js";
import { formatConfigValidation, validateRuntimeConfig } from "./config.js";
import { recordRuntimeEvidence } from "./evidence.js";
import { isPotentialWriteToolCall, shouldBlockDangerousToolCall, shouldBlockMutationInPlanning, shouldBlockSprintStatusMutation, shouldBlockStoryDoneMutation, shouldBlockWriteForAmbiguousResolution } from "./gates.js";
import { formatGrillClosureRecommendation, recommendGrillClosure } from "./grill.js";
import { writeRuntimeHandoff } from "./handoff.js";
import { formatHealthReport, runHealthCheck } from "./health.js";
import { formatLedgerSummary, summarizeLedger } from "./ledger.js";
import { loadPathConfig } from "./paths.js";
import { attachPhase3ResumeState, buildPhase3AutomationPlan, formatPhase3AutomationPlan, validatePhase3ReadinessForPhase4 } from "./phase3.js";
import { attachPhase4ResumeState } from "./phase4.js";
import { decideWorkflowLaunchPolicy, type WorkflowFreshLaunchMode } from "./prompt-policy.js";
import { buildRuntimeProjectsReport, formatRuntimeProjectsReport, parseProjectsArgs } from "./projects.js";
import { ensureProjectRegistered, formatPhysicalFolderRenamePreflight, formatProjectRegistrationResult, preflightPhysicalFolderRename, renameRegisteredProject } from "./project.js";
import { loadRegistry, type RegistryOptions } from "./registry.js";
import { confirmProjectVariantChoice, confirmWorkspaceRebind, formatProjectPickerDetails, formatResolutionResult, isGenericGitRepoIntentRequired, reconcileExistingWorkspace, resolveActiveProject, shouldActivateResolvedProject, shouldBlockProjectInit } from "./resolution.js";
import { evaluateReadinessGate, formatGateCard } from "./readiness.js";
import { buildResumeProjectResolution, formatResumeProjectResult, resolveResumeProject } from "./resume.js";
import { formatReviewRunResult, runParallelReviewDelegation } from "./review.js";
import { recommendNext, summarizeCompletion } from "./scanner.js";
import { loadSprintStatus, summarizeSprint, validateSprintDocument } from "./sprint.js";
import { scanStoryStatusFiles } from "./story.js";
import { buildContinuationBootstrapPrompt, buildStartMenu, buildStartProjectOptions, buildStartRouterPrompt, findLatestProjectHandoff, parseStartNewArgs, parseStartNewText, parseStartRouterReply, type StartProjectOption } from "./start.js";
import { activateState, deactivateState, isAutonomousPhase, loadState, recordWorkflowLaunch, saveState, setPhase, summarizeStateForSession, type RuntimePhase, type RuntimeState } from "./state.js";
import { buildRuntimeStatusReport, formatRuntimeStatusReport } from "./status.js";
import { formatTransitionPrompt } from "./transition.js";
import { commandHelp, formatRecommendation, formatRuntimeHelp, formatState } from "./ui.js";
import { applyLocalVersioningChoice, formatLocalVersioningResult } from "./versioning.js";
import { createDedicatedWorkspace, formatDedicatedWorkspaceResult } from "./workspace.js";

const VALID_PHASES: RuntimePhase[] = ["0-init", "1-analysis", "2-planning", "3-solutioning", "4-implementation", "5-ready-for-use", "anytime"];
const START_ROUTER_TTL_MS = 15 * 60 * 1000;
const CANONICAL_EXTENSION_COMMANDS = new Set(["bmad", "bmad-start", "bmad-help"]);

interface PendingStartRouter {
  cwd: string;
  options: StartProjectOption[];
  awaitingNewProjectName?: boolean;
  createdAt: number;
}

export interface BmadRuntimeExtensionOptions {
  registryOptions?: RegistryOptions;
}

const pendingStartRouters = new Map<string, PendingStartRouter>();

function normalizeRuntimeSource(value: string | undefined): string {
  return (value ?? "").replaceAll(String.fromCharCode(92), "/").toLowerCase();
}

function baseCommandName(name: string): string {
  return name.replace(/:\d+$/, "");
}

function isBmadRuntimeCommand(command: { name: string; source?: string; sourceInfo?: { path?: string; source?: string } }): boolean {
  if (command.source !== "extension") return false;
  if (!CANONICAL_EXTENSION_COMMANDS.has(baseCommandName(command.name))) return false;
  const sourcePath = normalizeRuntimeSource(command.sourceInfo?.path);
  const sourceName = normalizeRuntimeSource(command.sourceInfo?.source);
  return sourcePath.endsWith("/extensions/bmad-runtime/index.ts") || sourceName.includes("pi-bmad-runtime");
}

function anotherBmadRuntimeAlreadyRegistered(pi: ExtensionAPI): boolean {
  try {
    return pi.getCommands().some(isBmadRuntimeCommand);
  } catch {
    return false;
  }
}

function runtimePackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function sessionKey(ctx: any): string {
  return ctx.sessionManager?.getSessionFile?.() ?? ctx.cwd;
}

function pathsEquivalent(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const normalize = (value: string) => path.resolve(value).replaceAll(String.fromCharCode(92), "/").toLowerCase();
  return normalize(a) === normalize(b);
}

function freshPendingRouter(pending: PendingStartRouter | undefined): pending is PendingStartRouter {
  return !!pending && Date.now() - pending.createdAt <= START_ROUTER_TTL_MS;
}

function kickoffPrompt(): string {
  return `/skill:bmad-runtime-for-pi start interview

You are now inside BMAD Runtime for Pi. Start the orchestrator interview with a Trail Familiarity Check:
1. Ask whether the user already knows the BMAD track/module they want.
2. If yes, accept only valid planning tracks (Quick Flow, BMad Method, Enterprise) or installed/official module trails (core, bmm, bmb, cis, gds, tea).
3. If no, summarize the options briefly in natural language and recommend a route from the user's intent.
4. Ask for the product/project goal if it is not already clear.
Do not require the user to memorize slash commands. Do not invent fork-specific routes, external adapter behavior, or non-BMAD planning paths. Use the user's current language unless project config says otherwise.`;
}

function runtimeContext(stateText: string, recommendationText: string): string {
  return `[BMAD RUNTIME FOR PI ACTIVE]

Runtime state:
${stateText}

${recommendationText}

Operating rules:
- You are the Pi BMAD orchestrator. Do not invent a separate named persona, fork model, or external adapter unless the user explicitly asks for one.
- BMAD artifacts and runtime state are source of truth, not chat memory.
- Phase 1/2 are human-in-loop interview and planning phases: ask hard questions, use grill-with-docs for terminology/decision pressure, and do not mutate product code.
- Phase 3/4 are autonomous by default: execute BMAD workflows without routine user involvement, asking only for true blockers from the autonomy contract.
- Automation is the normal behavior of /bmad-start and resume; do not ask the user to run a separate automation command.
- Free-form user questions are allowed, but keep the BMAD anchor visible: current project, mode/phase, current workflow, and next trail step when relevant.
- Free exploration is not gate approval. Canonical artifact promotion, phase advancement, readiness, waiver, or done status requires explicit artifact/gate evidence.
- Engine/runtime artifacts are protected. Consumer-project task docs may be ephemeral only after their result is captured in sprint/status/evidence.
- Do not escape BMAD Runtime unless the user explicitly runs /bmad exit.
- Prefer fresh context windows for workflow runs.
[/BMAD RUNTIME FOR PI ACTIVE]`;
}

function parseDedicatedInit(rest: string[]): { projectName: string; rootPreference?: string; localVersioning?: "init" | "skip"; error?: string } | undefined {
  const dedicatedIndex = rest.indexOf("--dedicated");
  if (dedicatedIndex < 0) return undefined;
  const nameParts: string[] = [];
  let rootPreference: string | undefined;
  let localVersioning: "init" | "skip" | undefined;
  for (let index = dedicatedIndex + 1; index < rest.length; index++) {
    const token = rest[index];
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
      if (!rest[index + 1] || rest[index + 1]!.startsWith("--")) {
        return { projectName: nameParts.join(" ").trim(), localVersioning, error: "--root requires a path value" };
      }
      rootPreference = rest[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith("--")) continue;
    nameParts.push(token);
  }
  return { projectName: nameParts.join(" ").trim(), rootPreference, localVersioning };
}

interface ParsedRenameArgs {
  displayName: string;
  recordEvidence: boolean;
  physicalFolder: boolean;
  folderName: string;
  confirmFolderRename: boolean;
  error?: string;
}

function parseRenameArgs(rest: string[]): ParsedRenameArgs {
  const displayParts: string[] = [];
  const folderParts: string[] = [];
  let recordEvidence = false;
  let physicalFolder = false;
  let confirmFolderRename = false;
  let collectFolderName = false;

  for (const token of rest) {
    if (token === "--record-evidence" || token === "--evidence") {
      recordEvidence = true;
      collectFolderName = false;
      continue;
    }
    if (token === "--physical-folder" || token === "--rename-folder" || token === "--folder") {
      physicalFolder = true;
      collectFolderName = true;
      continue;
    }
    if (token === "--confirm-folder-rename") {
      confirmFolderRename = true;
      collectFolderName = false;
      continue;
    }
    if (token.startsWith("--")) {
      collectFolderName = false;
      continue;
    }
    if (collectFolderName) folderParts.push(token);
    else displayParts.push(token);
  }

  const displayName = displayParts.join(" ").trim();
  const folderName = folderParts.join(" ").trim();
  if (physicalFolder && displayName) {
    return {
      displayName,
      recordEvidence,
      physicalFolder,
      folderName,
      confirmFolderRename,
      error: "Physical folder preflight is separate from display-name rename. Use /bmad rename <name> for display name, or /bmad rename --physical-folder <folder> --confirm-folder-rename for the folder preflight.",
    };
  }
  if (physicalFolder && !folderName) {
    return {
      displayName,
      recordEvidence,
      physicalFolder,
      folderName,
      confirmFolderRename,
      error: "--physical-folder requires a folder name after the flag.",
    };
  }
  return { displayName, recordEvidence, physicalFolder, folderName, confirmFolderRename };
}

function loadRecommendation(cwd: string) {
  const catalog = loadBmadCatalog(cwd);
  const cfg = loadPathConfig(cwd);
  const rec = recommendNext(catalog.rows, cfg);
  return { catalog, cfg, rec };
}



function formatRuntimeRecommendation(cwd: string, state = loadState(cwd)): string {
  const { cfg, rec } = loadRecommendation(cwd);
  if (state.phase === "3-solutioning") return formatPhase3AutomationPlan(buildPhase3AutomationPlan(cwd, state));
  const sprint = loadSprintStatus(cfg);
  if (state.phase === "4-implementation" && sprint.doc) return formatPhase4AutomationRecommendation(recommendPhase4Automation(sprint.doc, cfg, buildPhase4AutomationContext(cwd, cfg)));
  return formatRecommendation(rec);
}

function buildRuntimeHelpContent(cwd: string, state = loadState(cwd)): string {
  const { catalog, cfg, rec } = loadRecommendation(cwd);
  const sprint = loadSprintStatus(cfg);
  const phase4Automation = state.phase === "4-implementation" && sprint.doc ? recommendPhase4Automation(sprint.doc, cfg, buildPhase4AutomationContext(cwd, cfg)) : undefined;
  return formatRuntimeHelp({ state, recommendation: rec, catalogRows: catalog.rows, phase4Automation });
}

type FreshLaunchMode = WorkflowFreshLaunchMode;

interface ParsedRunArgs {
  target: string;
  extraArgs: string;
  fresh: FreshLaunchMode;
}

function parseRunArgs(parts: string[]): ParsedRunArgs {
  let fresh: FreshLaunchMode = "ask";
  const positional: string[] = [];
  for (const part of parts) {
    if (part === "--same-session" || part === "--no-fresh") fresh = "never";
    else if (part === "--fresh") fresh = "always";
    else if (part === "--no-confirm") fresh = "always";
    else positional.push(part);
  }
  const [target = "next", ...extra] = positional;
  return { target, extraArgs: extra.join(" ").trim(), fresh };
}

function rowInvocationArgs(row: BmadCatalogRow | undefined, extraArgs: string): string {
  const parts: string[] = [];
  if (row?.action) parts.push(row.action);
  if (row?.args && !/^\[[^\]]+\]$/.test(row.args.trim())) parts.push(row.args.trim());
  if (extraArgs) parts.push(extraArgs);
  return parts.join(" ").trim();
}

function buildWorkflowPrompt(row: BmadCatalogRow | undefined, skill: string, state: { mode: string; phase: string }, extraArgs: string): string {
  const invocationArgs = rowInvocationArgs(row, extraArgs);
  const invocation = `/skill:${skill}${invocationArgs ? ` ${invocationArgs}` : ""}`;
  const target = row ? `${row.displayName} (${row.menuCode || row.skill})` : skill;
  return `${invocation}

BMAD Runtime target workflow: ${target}.
Follow the workflow exactly. Runtime mode is ${state.mode}; phase is ${state.phase}.
If this workflow reaches a checkpoint, obey the workflow checkpoint. Otherwise continue until the workflow's own completion or halt condition.`;
}

function saveRuntimeState(cwd: string, state: RuntimeState): RuntimeState {
  return saveState(cwd, attachPhase4ResumeState(cwd, attachPhase3ResumeState(cwd, state)));
}

async function sendWorkflowInvocation(args: string, ctx: any, prompt: string, fresh: FreshLaunchMode, state: RuntimeState): Promise<boolean> {
  if (fresh === "never") {
    ctx.ui.notify("Launching BMAD workflow in current session.", "warning");
    return false;
  }

  if (typeof ctx.newSession === "function") {
    const launchPolicy = decideWorkflowLaunchPolicy(state, fresh, true, Boolean(ctx.hasUI));
    const shouldLaunchFresh =
      launchPolicy.launchFresh ||
      (launchPolicy.askForConfirmation && (await ctx.ui.confirm("BMAD fresh session", `Launch ${args} in a fresh Pi session? BMAD recommends a fresh context per workflow.`)));
    if (shouldLaunchFresh) {
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile?.(),
        withSession: async (nextCtx: any) => {
          await nextCtx.sendUserMessage(prompt);
        },
      });
      return true;
    }
  }

  ctx.ui.notify("Launching BMAD workflow in current session.", "warning");
  return false;
}

export default function bmadRuntimeExtension(pi: ExtensionAPI, options: BmadRuntimeExtensionOptions = {}): void {
  if (anotherBmadRuntimeAlreadyRegistered(pi)) return;

  const registryOptions = options.registryOptions ?? {};

  const sendConversationalStart = async (ctx: any) => {
    const state = loadState(ctx.cwd);
    const resolution = await resolveActiveProject(ctx.cwd, registryOptions);
    const registry = await loadRegistry(registryOptions).catch(() => undefined);
    const registryProjects = registry?.ok ? registry.value.projects : [];
    const options = buildStartProjectOptions(resolution, registryProjects);
    pendingStartRouters.set(sessionKey(ctx), {
      cwd: ctx.cwd,
      options,
      createdAt: Date.now(),
    });
    const menu = buildStartMenu(ctx.cwd, resolution, state, undefined, options);
    pi.sendMessage({ customType: "bmad-runtime", content: menu, display: true }, { triggerTurn: false });
    pi.setSessionName?.("BMAD Start");
    pi.sendUserMessage(buildStartRouterPrompt(ctx.cwd, resolution, state, undefined, options));
  };

  const continueCurrentWorkspace = async (ctx: any) => {
    let state = loadState(ctx.cwd);
    let resolution = await resolveActiveProject(ctx.cwd, registryOptions);
    let reconcileEvidencePath: string | undefined;
    if (resolution.confidence === "local_workspace_unregistered" && resolution.reconcileAllowed) {
      const reconcile = await reconcileExistingWorkspace(ctx.cwd, registryOptions);
      const evidence = recordRuntimeEvidence(ctx.cwd, {
        command: "/bmad-start",
        outcome: reconcile.ok ? "ok" : "blocked",
        summary: reconcile.ok
          ? "Existing BMAD workspace reconciled into Runtime Home registry metadata before activation."
          : "Existing BMAD workspace reconcile failed with structured recovery before activation.",
        touchedPaths: reconcile.touchedPaths,
        details: reconcile,
      });
      reconcileEvidencePath = evidence.relativePath;
      if (!reconcile.ok) {
        pi.sendMessage({ customType: "bmad-runtime", content: `${formatResolutionResult(resolution, ctx.cwd)}\n\n# Reconcile Result\n\n- OK: false\n- Write occurred: ${reconcile.writeOccurred}\n- Recovery: ${reconcile.recoveryAction ?? "none"}\n- Error: ${reconcile.error ?? "unknown"}\n- Evidence: ${evidence.relativePath}`, display: true }, { triggerTurn: false });
        ctx.ui.notify("BMAD Runtime start blocked: existing workspace reconcile failed before activation.", "warning");
        return;
      }
      resolution = await resolveActiveProject(ctx.cwd, registryOptions);
    }
    const resolutionText = `${formatResolutionResult(resolution, ctx.cwd)}${reconcileEvidencePath ? `\n\nReconcile evidence: ${reconcileEvidencePath}` : ""}`;
    if (!shouldActivateResolvedProject(resolution)) {
      pi.sendMessage({ customType: "bmad-runtime", content: resolutionText, display: true }, { triggerTurn: false });
      ctx.ui.notify("BMAD Runtime start blocked before mutation: active project resolution was not unique_confident. writeOccurred: false", "warning");
      return;
    }
    const priorHandoff = findLatestProjectHandoff(ctx.cwd);
    state = saveRuntimeState(ctx.cwd, activateState(state));
    pi.appendEntry("bmad-runtime-state", summarizeStateForSession(state));
    pi.sendMessage({ customType: "bmad-runtime", content: resolutionText, display: true }, { triggerTurn: false });
    ctx.ui.notify(`BMAD Runtime activated.\n${formatState(state)}`, "info");
    pi.setSessionName?.(`BMAD Runtime: ${resolution.selectedProject?.displayName ?? "Project"}`);
    pi.sendUserMessage(buildContinuationBootstrapPrompt(ctx.cwd, resolution, state, priorHandoff));
  };

  const continueSelectedProject = async (ctx: any, option: StartProjectOption) => {
    if (option.requiresRebind) {
      const rebind = await confirmWorkspaceRebind(ctx.cwd, registryOptions);
      const evidence = recordRuntimeEvidence(ctx.cwd, {
        command: "/bmad-start rebind",
        outcome: rebind.ok ? "ok" : "blocked",
        summary: rebind.ok
          ? "Confirmed moved/cloned BMAD workspace rebind; current root registered before activation."
          : "Workspace rebind confirmation failed before activation.",
        touchedPaths: rebind.touchedPaths,
        details: rebind,
      });
      if (!rebind.ok) {
        pi.sendMessage({
          customType: "bmad-runtime",
          content: [
            "# BMAD Workspace Rebind",
            "",
            `OK: false`,
            `Project ID: ${rebind.projectId ?? option.projectId}`,
            `Write occurred: ${rebind.writeOccurred}`,
            `Recovery: ${rebind.recoveryAction ?? "none"}`,
            `Error: ${rebind.error ?? "unknown"}`,
            `Evidence: ${evidence.relativePath}`,
          ].join("\n"),
          display: true,
        }, { triggerTurn: false });
        ctx.ui.notify("BMAD workspace rebind blocked before activation.", "warning");
        return;
      }
      pi.sendMessage({
        customType: "bmad-runtime",
        content: [
          "# BMAD Workspace Rebind",
          "",
          `OK: true`,
          `Project ID: ${rebind.projectId ?? option.projectId}`,
          `Added known root: ${rebind.addedKnownRoot ?? ctx.cwd}`,
          `Write occurred: ${rebind.writeOccurred}`,
          `Evidence: ${evidence.relativePath}`,
        ].join("\n"),
        display: true,
      }, { triggerTurn: false });
      await continueCurrentWorkspace(ctx);
      return;
    }
    if (option.requiresVariantChoice) {
      const variant = await confirmProjectVariantChoice(ctx.cwd, registryOptions);
      const evidence = recordRuntimeEvidence(ctx.cwd, {
        command: "/bmad-start variant-choice",
        outcome: variant.ok ? "ok" : "blocked",
        summary: variant.ok
          ? "Confirmed current git branch/worktree/clone variant before activation."
          : "Project variant confirmation failed before activation.",
        touchedPaths: variant.touchedPaths,
        details: variant,
      });
      if (!variant.ok) {
        pi.sendMessage({
          customType: "bmad-runtime",
          content: [
            "# BMAD Project Variant Choice",
            "",
            "OK: false",
            `Project ID: ${variant.projectId ?? option.projectId}`,
            `Write occurred: ${variant.writeOccurred}`,
            `Recovery: ${variant.recoveryAction ?? "none"}`,
            `Error: ${variant.error ?? "unknown"}`,
            `Evidence: ${evidence.relativePath}`,
          ].join("\n"),
          display: true,
        }, { triggerTurn: false });
        ctx.ui.notify("BMAD project variant choice blocked before activation.", "warning");
        return;
      }
      pi.sendMessage({
        customType: "bmad-runtime",
        content: [
          "# BMAD Project Variant Choice",
          "",
          "OK: true",
          `Project ID: ${variant.projectId ?? option.projectId}`,
          `Write occurred: ${variant.writeOccurred}`,
          `Evidence: ${evidence.relativePath}`,
        ].join("\n"),
        display: true,
      }, { triggerTurn: false });
      await continueCurrentWorkspace(ctx);
      return;
    }
    if (!option.workspacePath || !pathsEquivalent(option.workspacePath, ctx.cwd)) {
      pi.sendMessage({
        customType: "bmad-runtime",
        content: [
          "# BMAD Project Selected",
          "",
          `Project: ${option.displayName} (${option.projectId})`,
          `Workspace: ${option.workspacePath ?? "unknown"}`,
          "",
          "Write occurred: false",
          "",
          "Pi currently has no safe runtime cwd switch exposed to this command. Open Pi in the selected workspace and run `/bmad-start`; the runtime will resume from the handoff/state there.",
        ].join("\n"),
        display: true,
      }, { triggerTurn: false });
      ctx.ui.notify("BMAD project selected; open Pi in that workspace to continue safely.", "info");
      return;
    }
    await continueCurrentWorkspace(ctx);
  };

  const createNewProjectFromRouter = async (ctx: any, rawProjectName: string) => {
    const resolution = await resolveActiveProject(ctx.cwd, registryOptions);
    const parsed = parseStartNewText(rawProjectName);
    if (parsed.error || !parsed.projectName) {
      pi.sendMessage({ customType: "bmad-runtime", content: `# BMAD New Project\n\nProject name is still needed. Reply with a name, for example: \`Guardinha Noturno\`.\n\nWrite occurred: false`, display: true }, { triggerTurn: false });
      pendingStartRouters.set(sessionKey(ctx), {
        cwd: ctx.cwd,
        options: [],
        awaitingNewProjectName: true,
        createdAt: Date.now(),
      });
      return;
    }
    const dedicated = await createDedicatedWorkspace({
      cwd: ctx.cwd,
      projectName: parsed.projectName,
      rootPreference: parsed.rootPreference,
      rootSource: parsed.rootPreference ? "flag" : undefined,
      sourceResolution: resolution,
      packageRoot: runtimePackageRoot(),
    }, registryOptions);
    pi.appendEntry("bmad-runtime-dedicated-workspace", dedicated);
    const dedicatedWorkspacePath = dedicated.ok ? dedicated.workspacePath : undefined;
    const localVersioning = dedicatedWorkspacePath && parsed.localVersioning
      ? applyLocalVersioningChoice(dedicatedWorkspacePath, parsed.localVersioning)
      : undefined;
    if (localVersioning) {
      pi.appendEntry("bmad-runtime-local-versioning", localVersioning);
      recordRuntimeEvidence(dedicatedWorkspacePath!, {
        command: "/bmad-start new local-versioning",
        outcome: localVersioning.ok ? "ok" : "blocked",
        summary: localVersioning.ok
          ? "Local versioning choice processed without any remote, push or publication action."
          : "Local versioning choice was blocked with structured recovery.",
        touchedPaths: localVersioning.touchedPaths,
        details: localVersioning,
      });
    }
    const next = dedicated.ok
      ? [
          "",
          "# Next Step",
          "",
          dedicated.packageSpec
            ? "The runtime package was added to the new workspace `.pi/settings.json`."
            : "Package propagation was not available; install this runtime package in the new workspace before opening Pi.",
          "",
          parsed.localVersioning
            ? `Local versioning choice: ${parsed.localVersioning}.`
            : "Local versioning choice not set. To create a local-only initial commit, start a new project with `--git-init`; to decline, use `--no-git-init`.",
          localVersioning ? formatLocalVersioningResult(dedicatedWorkspacePath!, localVersioning) : "",
          "",
          `Open Pi in: ${dedicated.workspacePath}`,
          "Then run `/bmad-start` there to begin the project.",
        ].join("\n")
      : "";
    pi.sendMessage({ customType: "bmad-runtime", content: `${formatDedicatedWorkspaceResult(dedicated)}${next}`, display: true }, { triggerTurn: false });
    ctx.ui.notify(
      dedicated.ok
        ? `Dedicated BMAD workspace created.\n${dedicated.workspacePath}`
        : `Dedicated BMAD workspace creation failed.\nRecovery: ${dedicated.recoveryAction}`,
      dedicated.ok ? "info" : "warning",
    );
  };

  pi.registerCommand("bmad-help", {
    description: "Show contextual Pi+BMad stage, next step, and command help",
    handler: async (_rawArgs, ctx) => {
      pi.sendMessage({ customType: "bmad-runtime-help", content: buildRuntimeHelpContent(ctx.cwd), display: true }, { triggerTurn: false });
    },
  });

  pi.registerCommand("bmad-start", {
    description: "Start BMAD Runtime with a conversational project picker",
    handler: async (_rawArgs, ctx) => {
      await sendConversationalStart(ctx);
    },
  });

  pi.registerCommand("bmad", {
    description: "BMAD Runtime for Pi: stateful BMAD orchestration, gates, and workflow launch",
    getArgumentCompletions(prefix: string) {
      const items = ["init", "rename", "projects", "resume", "health", "readiness", "transition", "start", "status", "next", "run", "phase", "review", "handoff", "interview", "grill", "exit", "help"];
      return items.filter((item) => item.startsWith(prefix)).map((item) => ({ value: item, label: item }));
    },
    handler: async (rawArgs, ctx) => {
      const args = rawArgs.trim();
      const [cmd = "status", ...rest] = args.split(/\s+/).filter(Boolean);
      let state = loadState(ctx.cwd);

      if (cmd === "help" || cmd === "--help" || cmd === "-h") {
        pi.sendMessage({ customType: "bmad-runtime-help", content: buildRuntimeHelpContent(ctx.cwd, state), display: true }, { triggerTurn: false });
        return;
      }

      if (cmd === "init") {
        const dedicatedInit = parseDedicatedInit(rest);
        if (dedicatedInit) {
          const resolution = await resolveActiveProject(ctx.cwd, registryOptions);
          if (dedicatedInit.error) {
            pi.sendMessage({ customType: "bmad-runtime", content: `# Dedicated Local Project Workspace\n\nUsage: /bmad init --dedicated <project-name> [--root <path>]\n\nError: ${dedicatedInit.error}\nWrite occurred: false`, display: true }, { triggerTurn: false });
            ctx.ui.notify(`BMAD dedicated init blocked: ${dedicatedInit.error}. writeOccurred: false`, "warning");
            return;
          }
          if (!dedicatedInit.projectName) {
            pi.sendMessage({ customType: "bmad-runtime", content: "# Dedicated Local Project Workspace\n\nUsage: /bmad init --dedicated <project-name> [--root <path>]\n\nWrite occurred: false", display: true }, { triggerTurn: false });
            ctx.ui.notify("BMAD dedicated init blocked: project name is required. writeOccurred: false", "warning");
            return;
          }
          if (shouldActivateResolvedProject(resolution)) {
            pi.sendMessage({ customType: "bmad-runtime", content: `${formatResolutionResult(resolution, ctx.cwd)}\n\n# Dedicated Local Project Workspace Blocked\n\n- Reason: current cwd already resolves to a unique active BMAD Project Workspace.\n- Write occurred: false\n- Recovery: run dedicated init from an unsafe/no-workspace context or use /bmad-start to select/create another project.`, display: true }, { triggerTurn: false });
            ctx.ui.notify("BMAD dedicated init blocked: current cwd already has a unique project. writeOccurred: false", "warning");
            return;
          }
          const dedicated = await createDedicatedWorkspace({
            cwd: ctx.cwd,
            projectName: dedicatedInit.projectName,
            rootPreference: dedicatedInit.rootPreference,
            rootSource: dedicatedInit.rootPreference ? "flag" : undefined,
            sourceResolution: resolution,
            packageRoot: runtimePackageRoot(),
          }, registryOptions);
          pi.appendEntry("bmad-runtime-dedicated-workspace", dedicated);
          const dedicatedWorkspacePath = dedicated.ok ? dedicated.workspacePath : undefined;
          const localVersioning = dedicatedWorkspacePath && dedicatedInit.localVersioning
            ? applyLocalVersioningChoice(dedicatedWorkspacePath, dedicatedInit.localVersioning)
            : undefined;
          if (localVersioning) {
            pi.appendEntry("bmad-runtime-local-versioning", localVersioning);
            recordRuntimeEvidence(dedicatedWorkspacePath!, {
              command: "/bmad init --dedicated local-versioning",
              outcome: localVersioning.ok ? "ok" : "blocked",
              summary: localVersioning.ok
                ? "Local versioning choice processed without any remote, push or publication action."
                : "Local versioning choice was blocked with structured recovery.",
              touchedPaths: localVersioning.touchedPaths,
              details: localVersioning,
            });
          }
          const localVersioningText = dedicated.ok
            ? [
                "",
                dedicatedInit.localVersioning
                  ? `Local versioning choice: ${dedicatedInit.localVersioning}.`
                  : "Local versioning choice not set. Add `--git-init` to create a local-only initial commit, or `--no-git-init` to decline.",
                localVersioning ? formatLocalVersioningResult(dedicatedWorkspacePath!, localVersioning) : "",
              ].join("\n")
            : "";
          pi.sendMessage({ customType: "bmad-runtime", content: `${formatResolutionResult(resolution, ctx.cwd)}\n\n${formatDedicatedWorkspaceResult(dedicated)}${localVersioningText}`, display: true }, { triggerTurn: false });
          ctx.ui.notify(
            dedicated.ok
              ? `Dedicated BMAD workspace created.\n${dedicated.workspacePath}\nEvidence: ${dedicated.evidencePath ?? "none"}`
              : `Dedicated BMAD workspace creation failed before ready/active.\nRecovery: ${dedicated.recoveryAction}\nWrite occurred: ${dedicated.writeOccurred}`,
            dedicated.ok ? "info" : "warning",
          );
          return;
        }
        const confirmGenericGitRepo = rest.includes("--confirm-generic-repo");
        const resolution = await resolveActiveProject(ctx.cwd, registryOptions);
        const initSafety = shouldBlockProjectInit(resolution, { confirmGenericGitRepo });
        if (initSafety.blocked) {
          pi.sendMessage({ customType: "bmad-runtime", content: `${formatResolutionResult(resolution, ctx.cwd)}\n\n# BMAD Init Blocked\n\n- Reason: ${initSafety.reason ?? "Initialization is not safe for the current active project resolution."}\n- Write occurred: false\n- Recovery: ${initSafety.recoveryAction ?? resolution.recoveryAction ?? "resolve-active-project-before-init"}\n- Explicit generic repo intent: ${confirmGenericGitRepo ? "confirmed" : "missing"}`, display: true }, { triggerTurn: false });
          ctx.ui.notify("BMAD init blocked before mutation: active project resolution requires explicit/safe intent. writeOccurred: false", "warning");
          return;
        }
        const result = await ensureProjectRegistered(ctx.cwd, registryOptions);
        state = loadState(ctx.cwd);
        const registrySummary = result.registry.ok
          ? {
              ok: true,
              writeOccurred: result.registry.writeOccurred,
              projects: result.registry.value.projects.length,
              projectId: result.identity.projectId,
            }
          : { ok: false, error: result.registry.error };
        pi.appendEntry("bmad-runtime-init", {
          created: result.created,
          reused: result.reused,
          skipped: result.skipped,
          identity: result.identity,
          baseline: result.baseline,
          registry: registrySummary,
        });
        pi.appendEntry("bmad-runtime-state", summarizeStateForSession(state));
        const recordEvidence = rest.includes("--record-evidence") || rest.includes("--evidence") || (confirmGenericGitRepo && isGenericGitRepoIntentRequired(resolution));
        const evidence = recordEvidence
          ? recordRuntimeEvidence(ctx.cwd, {
              command: confirmGenericGitRepo ? "/bmad init --confirm-generic-repo" : "/bmad init",
              outcome: result.registry.ok ? "ok" : "warning",
              summary: result.registry.ok
                ? (confirmGenericGitRepo && isGenericGitRepoIntentRequired(resolution)
                  ? "Generic git repository initialization completed after explicit BMAD intent confirmation."
                  : "Project initialization and registry update completed.")
                : "Project initialization completed locally, but registry update failed.",
              touchedPaths: [...result.created, ...result.reused, ...result.skipped],
              counts: { created: result.created.length, reused: result.reused.length, skipped: result.skipped.length },
              details: {
                explicitGenericGitRepoIntent: confirmGenericGitRepo,
                resolutionBeforeInit: {
                  confidence: resolution.confidence,
                  reason: resolution.reason,
                  nextSafeAction: resolution.nextSafeAction,
                  writeAllowed: resolution.writeAllowed,
                  writeOccurred: resolution.writeOccurred,
                  recoveryAction: resolution.recoveryAction,
                  canonicalPaths: resolution.canonicalPaths,
                  boundaries: resolution.boundaries,
                  evidenceUsed: resolution.evidenceUsed,
                  genericGitRepo: resolution.genericGitRepo,
                },
                projectId: result.identity.projectId,
                baseline: result.baseline,
                registry: result.registry.ok
                  ? { writeOccurred: result.registry.writeOccurred, projects: result.registry.value.projects.length }
                  : { error: result.registry.error },
              },
            })
          : undefined;
        ctx.ui.notify(
          `${formatProjectRegistrationResult(result)}${evidence ? `\n\nEvidence: ${evidence.relativePath}` : ""}`,
          result.registry.ok ? "info" : "warning",
        );
        return;
      }

      if (cmd === "rename") {
        const renameArgs = parseRenameArgs(rest);
        if (renameArgs.error) {
          ctx.ui.notify(renameArgs.error, "warning");
          return;
        }
        if (renameArgs.physicalFolder) {
          const result = await preflightPhysicalFolderRename(
            ctx.cwd,
            renameArgs.folderName,
            { explicitConfirmation: renameArgs.confirmFolderRename },
          );
          pi.appendEntry("bmad-runtime-physical-folder-rename-preflight", result);
          const evidence = renameArgs.recordEvidence
            ? recordRuntimeEvidence(ctx.cwd, {
                command: "/bmad rename --physical-folder",
                outcome: result.ok ? "ok" : "blocked",
                summary: result.ok
                  ? "Physical folder rename preflight passed; runtime did not move the folder."
                  : "Physical folder rename preflight was blocked before mutation.",
                touchedPaths: [],
                details: result,
              })
            : undefined;
          ctx.ui.notify(
            `${formatPhysicalFolderRenamePreflight(result)}${evidence ? `\n\nEvidence: ${evidence.relativePath}` : ""}`,
            result.ok ? "info" : "warning",
          );
          return;
        }
        if (!renameArgs.displayName) {
          ctx.ui.notify("Usage: /bmad rename <new display name>", "warning");
          return;
        }
        const result = await renameRegisteredProject(ctx.cwd, renameArgs.displayName, registryOptions);
        const content = result.registry.ok
          ? [
              "BMAD project display name renamed.",
              `Project ID: ${result.registry.value.rename.projectId}`,
              `Previous display name: ${result.registry.value.rename.previousDisplayName}`,
              `New display name: ${result.registry.value.rename.displayName}`,
              `Historical alias added: ${result.registry.value.rename.addedHistoricalAlias ?? "none"}`,
              "Physical folder rename: not performed",
            ].join("\n")
          : [
              "BMAD project display name rename failed.",
              `Error: ${result.registry.error.code}`,
              `Message: ${result.registry.error.message}`,
              `Write occurred: ${result.registry.error.writeOccurred}`,
              `Recovery: ${result.registry.error.recoveryAction.action}`,
            ].join("\n");
        pi.appendEntry("bmad-runtime-rename", {
          projectId: result.initialization.identity.projectId,
          ok: result.registry.ok,
          displayName: renameArgs.displayName,
          result: result.registry.ok
            ? result.registry.value.rename
            : { error: result.registry.error },
        });
        const evidence = renameArgs.recordEvidence
          ? recordRuntimeEvidence(ctx.cwd, {
              command: "/bmad rename",
              outcome: result.registry.ok ? "ok" : "blocked",
              summary: result.registry.ok
                ? "Project display name rename completed without physical folder rename."
                : "Project display name rename was blocked before mutation or failed with structured recovery.",
              touchedPaths: result.registry.ok
                ? [".bmad-runtime/project-identity.json"]
                : [],
              details: result.registry.ok
                ? result.registry.value.rename
                : { error: result.registry.error },
            })
          : undefined;
        ctx.ui.notify(
          `${content}${evidence ? `\n\nEvidence: ${evidence.relativePath}` : ""}`,
          result.registry.ok ? "info" : "warning",
        );
        return;
      }

      if (cmd === "health" || cmd === "doctor") {
        const report = runHealthCheck(ctx.cwd, runtimePackageRoot(), registryOptions);
        const recordEvidence = rest.includes("--record-evidence") || rest.includes("--evidence");
        if (recordEvidence) pi.appendEntry("bmad-runtime-health", report);
        const evidence = recordEvidence
          ? recordRuntimeEvidence(ctx.cwd, {
              command: "/bmad health",
              outcome: report.counts.blocked > 0 ? "blocked" : report.counts.degraded > 0 ? "degraded" : report.counts.warning > 0 ? "warning" : "ok",
              summary: `Health check completed with ok=${report.counts.ok}, warning=${report.counts.warning}, degraded=${report.counts.degraded}, blocked=${report.counts.blocked}.`,
              packageVersion: report.packageVersion,
              counts: report.counts,
              details: report.findings,
            })
          : undefined;
        const content = `${formatHealthReport(report)}${evidence ? `\n\nEvidence: ${evidence.relativePath}` : ""}`;
        pi.sendMessage({ customType: "bmad-runtime", content, display: true }, { triggerTurn: false });
        return;
      }

      if (cmd === "projects") {
        try {
          const report = await buildRuntimeProjectsReport(ctx.cwd, { ...parseProjectsArgs(rest), registryOptions });
          pi.sendMessage({ customType: "bmad-runtime", content: formatRuntimeProjectsReport(report), display: true }, { triggerTurn: false });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          pi.sendMessage({ customType: "bmad-runtime", content: `# BMAD Projects\n\nProjects unavailable; read-only registry inspection failed before mutation.\n\nWrite occurred: false\nRecovery: repair Runtime Home registry metadata, then retry /bmad projects.\nError: ${message}`, display: true }, { triggerTurn: false });
        }
        return;
      }

      if (cmd === "resume") {
        const selector = rest.join(" ").trim();
        const resume = await resolveResumeProject(selector, { registryOptions });
        if (resume.status !== "ready" || !resume.workspacePath || !resume.state) {
          pi.sendMessage({ customType: "bmad-runtime", content: formatResumeProjectResult(resume), display: true }, { triggerTurn: false });
          ctx.ui.notify("BMAD resume did not change state; select one registered project by Stable ID, exact name, or alias.", resume.status === "ambiguous" ? "info" : "warning");
          return;
        }
        const priorHandoff = findLatestProjectHandoff(resume.workspacePath);
        const state = saveRuntimeState(resume.workspacePath, activateState(resume.state));
        const resumed = { ...resume, state };
        const resolution = buildResumeProjectResolution(resumed);
        pi.appendEntry("bmad-runtime-state", summarizeStateForSession(state));
        pi.sendMessage({ customType: "bmad-runtime", content: formatResumeProjectResult(resumed, { writeOccurred: true, handoffPath: priorHandoff?.relativePath }), display: true }, { triggerTurn: false });
        ctx.ui.notify(`BMAD project resumed.\n${resume.workspacePath}`, "info");
        pi.setSessionName?.(`BMAD Runtime: ${resume.project?.displayName ?? "Project"}`);
        pi.sendUserMessage(buildContinuationBootstrapPrompt(resume.workspacePath, resolution, state, priorHandoff));
        return;
      }

      if (cmd === "readiness") {
        const cfg = loadPathConfig(ctx.cwd);
        const artifacts = scanArtifactRegistry(cfg);
        const readiness = evaluateReadinessGate(cfg, artifacts);
        pi.sendMessage({ customType: "bmad-runtime", content: formatGateCard(readiness), display: true }, { triggerTurn: false });
        return;
      }

      if (cmd === "transition") {
        const { rec } = loadRecommendation(ctx.cwd);
        const cfg = loadPathConfig(ctx.cwd);
        const artifacts = scanArtifactRegistry(cfg).filter((entry) => entry.requiredForReadiness && entry.status !== "missing").map((entry) => `${entry.label}: ${entry.path}`);
        pi.sendMessage({ customType: "bmad-runtime", content: formatTransitionPrompt({ current: `${state.phase}/${state.currentWorkflow ?? "-"}`, destination: rec.row?.displayName ?? rec.row?.skill ?? "next BMAD step", artifacts, gate: "BMAD gate evidence required before state advancement" }), display: true }, { triggerTurn: false });
        return;
      }

      if (cmd === "start") {
        const [startAction = "", ...startRest] = rest;
        const detailIndex = rest.findIndex((item) => item === "details" || item === "--details");
        const detailSelector = detailIndex >= 0 ? rest.slice(detailIndex + 1).join(" ").trim() : "";
        let resolution = await resolveActiveProject(ctx.cwd, registryOptions);
        if (detailIndex >= 0) {
          const detailText = detailSelector ? `\n\n${formatProjectPickerDetails(resolution, detailSelector, ctx.cwd)}` : "";
          pi.sendMessage({ customType: "bmad-runtime", content: `${formatResolutionResult(resolution, ctx.cwd)}${detailText}`, display: true }, { triggerTurn: false });
          ctx.ui.notify("BMAD Runtime project details are read-only; no state, registry, reconcile, or kickoff was changed.", "info");
          return;
        }
        if (startAction === "new") {
          const startNew = parseStartNewArgs(startRest);
          if (startNew.error || !startNew.projectName) {
            pi.sendMessage({ customType: "bmad-runtime", content: `# BMAD Start New Project\n\nUsage: /bmad start new <project-name> [--root <path>]\n\nError: ${startNew.error ?? "project name is required"}\nWrite occurred: false`, display: true }, { triggerTurn: false });
            ctx.ui.notify(`BMAD start new blocked: ${startNew.error ?? "project name is required"}. writeOccurred: false`, "warning");
            return;
          }
          const dedicated = await createDedicatedWorkspace({
            cwd: ctx.cwd,
            projectName: startNew.projectName,
            rootPreference: startNew.rootPreference,
            rootSource: startNew.rootPreference ? "flag" : undefined,
            sourceResolution: resolution,
            packageRoot: runtimePackageRoot(),
          }, registryOptions);
          pi.appendEntry("bmad-runtime-dedicated-workspace", dedicated);
          const dedicatedWorkspacePath = dedicated.ok ? dedicated.workspacePath : undefined;
          const localVersioning = dedicatedWorkspacePath && startNew.localVersioning
            ? applyLocalVersioningChoice(dedicatedWorkspacePath, startNew.localVersioning)
            : undefined;
          if (localVersioning) {
            pi.appendEntry("bmad-runtime-local-versioning", localVersioning);
            recordRuntimeEvidence(dedicatedWorkspacePath!, {
              command: "/bmad start new local-versioning",
              outcome: localVersioning.ok ? "ok" : "blocked",
              summary: localVersioning.ok
                ? "Local versioning choice processed without any remote, push or publication action."
                : "Local versioning choice was blocked with structured recovery.",
              touchedPaths: localVersioning.touchedPaths,
              details: localVersioning,
            });
          }
          const installReminder = dedicated.ok
            ? [
                "",
                "# Next Step",
                "",
                dedicated.packageSpec
                  ? "The BMAD Runtime package was added to the new workspace `.pi/settings.json`. Open Pi there and run:"
                  : "Open Pi in the new workspace, install this package there, then run:",
                "",
                startNew.localVersioning
                  ? `Local versioning choice: ${startNew.localVersioning}.`
                  : "Local versioning choice not set. Add `--git-init` to create a local-only initial commit, or `--no-git-init` to decline.",
                localVersioning ? formatLocalVersioningResult(dedicatedWorkspacePath!, localVersioning) : "",
                "",
                "```text",
                "/bmad-start",
                "```",
              ].join("\n")
            : "";
          pi.sendMessage({ customType: "bmad-runtime", content: `${formatResolutionResult(resolution, ctx.cwd)}\n\n${formatDedicatedWorkspaceResult(dedicated)}${installReminder}`, display: true }, { triggerTurn: false });
          ctx.ui.notify(
            dedicated.ok
              ? `Dedicated BMAD workspace created.\n${dedicated.workspacePath}\nOpen Pi there and run /bmad-start.`
              : `Dedicated BMAD workspace creation failed before ready/active.\nRecovery: ${dedicated.recoveryAction}\nWrite occurred: ${dedicated.writeOccurred}`,
            dedicated.ok ? "info" : "warning",
          );
          return;
        }
        const continueRequested = startAction === "continue" || startAction === "resume" || startAction === "existing";
        if (!continueRequested) {
          await sendConversationalStart(ctx);
          return;
        }
        let reconcileEvidencePath: string | undefined;
        if (resolution.confidence === "local_workspace_unregistered" && resolution.reconcileAllowed) {
          const reconcile = await reconcileExistingWorkspace(ctx.cwd, registryOptions);
          pi.appendEntry("bmad-runtime-reconcile", reconcile);
          const evidence = recordRuntimeEvidence(ctx.cwd, {
            command: "/bmad start",
            outcome: reconcile.ok ? "ok" : "blocked",
            summary: reconcile.ok
              ? "Existing BMAD workspace reconciled into Runtime Home registry metadata before activation."
              : "Existing BMAD workspace reconcile failed with structured recovery before activation.",
            touchedPaths: reconcile.touchedPaths,
            details: reconcile,
          });
          reconcileEvidencePath = evidence.relativePath;
          if (!reconcile.ok) {
            const content = `${formatResolutionResult(resolution, ctx.cwd)}\n\n# Reconcile Result\n\n- OK: false\n- Write occurred: ${reconcile.writeOccurred}\n- Recovery: ${reconcile.recoveryAction ?? "none"}\n- Error: ${reconcile.error ?? "unknown"}\n- Evidence: ${evidence.relativePath}`;
            pi.sendMessage({ customType: "bmad-runtime", content, display: true }, { triggerTurn: false });
            ctx.ui.notify("BMAD Runtime start blocked: existing workspace reconcile failed before activation.", "warning");
            return;
          }
          resolution = await resolveActiveProject(ctx.cwd, registryOptions);
        }
        const detailText = detailSelector ? `\n\n${formatProjectPickerDetails(resolution, detailSelector, ctx.cwd)}` : "";
        const resolutionText = `${formatResolutionResult(resolution, ctx.cwd)}${detailText}${reconcileEvidencePath ? `\n\nReconcile evidence: ${reconcileEvidencePath}` : ""}`;
        if (!shouldActivateResolvedProject(resolution)) {
          pi.sendMessage({ customType: "bmad-runtime", content: resolutionText, display: true }, { triggerTurn: false });
          ctx.ui.notify(
            reconcileEvidencePath
              ? "BMAD Runtime start blocked after reconcile attempt: active project resolution was still not unique_confident. See reconcile evidence."
              : "BMAD Runtime start blocked before mutation: active project resolution was not unique_confident. writeOccurred: false",
            "warning",
          );
          return;
        }
        const priorHandoff = findLatestProjectHandoff(ctx.cwd);
        state = saveRuntimeState(ctx.cwd, activateState(state));
        pi.appendEntry("bmad-runtime-state", summarizeStateForSession(state));
        pi.sendMessage({ customType: "bmad-runtime", content: resolutionText, display: true }, { triggerTurn: false });
        ctx.ui.notify(`BMAD Runtime activated after active project resolution.\n${formatState(state)}`, "info");
        pi.setSessionName?.(`BMAD Runtime: ${resolution.selectedProject?.displayName ?? "Project"}`);
        pi.sendUserMessage(buildContinuationBootstrapPrompt(ctx.cwd, resolution, state, priorHandoff));
        return;
      }

      if (cmd === "exit" || cmd === "unlock" || cmd === "stop") {
        state = saveRuntimeState(ctx.cwd, deactivateState(state));
        pi.appendEntry("bmad-runtime-state", summarizeStateForSession(state));
        ctx.ui.notify("BMAD Runtime deactivated.", "info");
        return;
      }

      if (cmd === "phase") {
        const phase = rest[0] as RuntimePhase | undefined;
        if (!phase || !VALID_PHASES.includes(phase)) {
          ctx.ui.notify(`Invalid phase. Use one of: ${VALID_PHASES.join(", ")}`, "error");
          return;
        }
        if (phase === "4-implementation") {
          const readinessForPhase4 = validatePhase3ReadinessForPhase4(ctx.cwd, state);
          if (!readinessForPhase4.ok) {
            pi.sendMessage({
              customType: "bmad-runtime",
              content: [
                "# BMAD Phase Transition Blocked",
                "",
                "Phase 4 requires persisted readiness pass or scoped waiver evidence.",
                "Write occurred: false",
                "",
                "Issues:",
                ...readinessForPhase4.issues.map((issue) => `- ${issue}`),
              ].join("\n"),
              display: true,
            }, { triggerTurn: false });
            ctx.ui.notify("BMAD phase transition blocked: Phase 3 readiness evidence is incomplete.", "warning");
            return;
          }
        }
        state = saveRuntimeState(ctx.cwd, setPhase({ ...state, active: true }, phase));
        pi.appendEntry("bmad-runtime-state", summarizeStateForSession(state));
        ctx.ui.notify(`BMAD phase set.\n${formatState(state)}`, "info");
        return;
      }

      if (cmd === "review") {
        const cfg = loadPathConfig(ctx.cwd);
        const storyKey = rest[0] ?? state.currentStory ?? "";
        if (!storyKey) {
          ctx.ui.notify("Usage: /bmad review <story-key>", "error");
          return;
        }
        const storyPath = `${cfg.implementation_artifacts}/${storyKey}.md`;
        const run = await runParallelReviewDelegation({
          cwd: ctx.cwd,
          storyKey,
          storyPath,
          changedPaths: [storyPath],
          acceptanceCriteria: ["All story acceptance criteria are satisfied", "No unresolved patch-required or decision-needed findings remain", "Evidence links to story done gate"],
          evidenceLinks: [storyPath, `${cfg.implementation_artifacts}/sprint-status.yaml`],
        });
        pi.appendEntry("bmad-runtime-review", run);
        pi.sendMessage({ customType: "bmad-runtime", content: formatReviewRunResult(run), display: true }, { triggerTurn: false });
        return;
      }

      if (cmd === "handoff") {
        const note = rest.join(" ").trim();
        const handoff = writeRuntimeHandoff(ctx.cwd, {
          reason: "/bmad handoff",
          state,
          note,
          nextStep: formatRuntimeRecommendation(ctx.cwd, state),
        });
        pi.sendMessage({ customType: "bmad-runtime", content: `# BMAD Runtime Handoff\n\n- Path: ${handoff.relativePath}\n- Updated at: ${handoff.updatedAt}\n- Write occurred: true`, display: true }, { triggerTurn: false });
        ctx.ui.notify(`BMAD handoff updated: ${handoff.relativePath}`, "info");
        return;
      }

      if (cmd === "grill") {
        state = saveRuntimeState(ctx.cwd, activateState(state));
        pi.appendEntry("bmad-runtime-state", summarizeStateForSession(state));
        const target = rest.join(" ").trim();
        const prompt = target
          ? `/skill:grill-with-docs ${target}`
          : "/skill:grill-with-docs Challenge the current BMAD plan or most relevant planning artifact against existing CONTEXT.md, ADRs, docs, and code. Ask one question at a time and update CONTEXT.md/ADRs only when decisions crystallize.";
        pi.sendUserMessage(prompt);
        return;
      }

      if (cmd === "interview") {
        state = saveRuntimeState(ctx.cwd, { ...state, active: true, mode: "interview", phase: state.phase === "3-solutioning" || state.phase === "4-implementation" ? "2-planning" : state.phase });
        pi.appendEntry("bmad-runtime-state", summarizeStateForSession(state));
        ctx.ui.notify(`BMAD interview mode enabled.\n${formatState(state)}`, "info");
        return;
      }

      if (cmd === "status" || cmd === "next" || cmd === "") {
        try {
          const report = await buildRuntimeStatusReport(ctx.cwd, { registryOptions });
          pi.sendMessage({ customType: "bmad-runtime", content: formatRuntimeStatusReport(report), display: true }, { triggerTurn: false });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          pi.sendMessage({ customType: "bmad-runtime", content: `# BMAD Runtime Status\n\nStatus unavailable; read-only status collection failed before mutation.\n\nWrite occurred: false\nRecovery: repair local runtime/artifact configuration, then retry /bmad status.\nError: ${message}`, display: true }, { triggerTurn: false });
        }
        return;
      }

      if (cmd === "run") {
        const parsed = parseRunArgs(rest);
        const { catalog, rec } = loadRecommendation(ctx.cwd);
        const row = parsed.target === "next" ? rec.row : findCatalogRow(catalog.rows, parsed.target);
        const skill = row?.skill ?? parsed.target.replace(/^\/+/, "");
        if (!skill || skill === "next") {
          ctx.ui.notify("No BMAD workflow target found. Use `/bmad next` to inspect recommendations or `/bmad run <menu-code-or-skill>`.", "error");
          return;
        }
        state = saveRuntimeState(
          ctx.cwd,
          recordWorkflowLaunch({ ...activateState(state), phase: (row?.phase as RuntimePhase | undefined) ?? state.phase }, {
            skill,
            displayName: row?.displayName,
            menuCode: row?.menuCode,
            phase: row?.phase ?? state.phase,
            launchArgs: parsed.extraArgs,
          }),
        );
        pi.appendEntry("bmad-runtime-state", summarizeStateForSession(state));
        const prompt = buildWorkflowPrompt(row, skill, state, parsed.extraArgs);
        const launchedInFreshSession = await sendWorkflowInvocation(skill, ctx, prompt, parsed.fresh, state);
        if (!launchedInFreshSession) pi.sendUserMessage(prompt);
        return;
      }

      ctx.ui.notify(`Unknown /bmad command: ${cmd}\n\n${commandHelp()}`, "error");
    },
  });

  pi.on("input", async (event, ctx) => {
    const key = sessionKey(ctx);
    const pending = pendingStartRouters.get(key);
    if (!freshPendingRouter(pending)) {
      if (pending) pendingStartRouters.delete(key);
      return { action: "continue" };
    }
    const text = event.text.trim();
    if (!text || text.startsWith("/")) return { action: "continue" };
    if (pending.awaitingNewProjectName) {
      pendingStartRouters.delete(key);
      await createNewProjectFromRouter(ctx, text);
      return { action: "handled" };
    }
    const reply = parseStartRouterReply(text, pending.options);
    if (reply.action === "continue") {
      pendingStartRouters.delete(key);
      await continueSelectedProject(ctx, reply.option);
      return { action: "handled" };
    }
    if (reply.action === "new") {
      if (!reply.projectName) {
        pendingStartRouters.set(key, { ...pending, awaitingNewProjectName: true, createdAt: Date.now() });
        pi.sendMessage({ customType: "bmad-runtime", content: "# BMAD New Project\n\nWhat should the new project be called?\n\nWrite occurred: false", display: true }, { triggerTurn: false });
        return { action: "handled" };
      }
      pendingStartRouters.delete(key);
      await createNewProjectFromRouter(ctx, reply.projectName);
      return { action: "handled" };
    }
    pi.sendMessage({
      customType: "bmad-runtime",
      content: [
        "# BMAD Start",
        "",
        "I could not map that answer to one of the listed projects or to a new project.",
        "",
        "Reply with a project number/name, or say `novo <project name>`.",
        "",
        "Write occurred: false",
      ].join("\n"),
      display: true,
    }, { triggerTurn: false });
    return { action: "handled" };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const state = loadState(ctx.cwd);
    if (!state.active) return;
    const stateText = formatState(state);
    const recommendationText = formatRuntimeRecommendation(ctx.cwd, state);
    ctx.ui.setStatus("bmad-runtime", ctx.ui.theme.fg(isAutonomousPhase(state) ? "warning" : "accent", `BMAD ${state.phase}`));
    return {
      message: {
        customType: "bmad-runtime-context",
        content: runtimeContext(stateText, recommendationText),
        display: false,
      },
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    const state = loadState(ctx.cwd);
    if (!state.active) return;
    let nextStep: string | undefined;
    try {
      nextStep = formatRuntimeRecommendation(ctx.cwd, state);
    } catch {
      nextStep = "Run /bmad status and continue from the runtime recommendation.";
    }
    writeRuntimeHandoff(ctx.cwd, {
      reason: "agent_end",
      state,
      nextStep,
      messages: event.messages,
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    const state = loadState(ctx.cwd);
    const input = event.input as Record<string, unknown>;
    const dangerReason = shouldBlockDangerousToolCall(state, ctx.cwd, event.toolName, input);
    if (dangerReason) return { block: true, reason: dangerReason };
    if (isPotentialWriteToolCall(event.toolName, input)) {
      const resolution = await resolveActiveProject(ctx.cwd, registryOptions).catch((error) => ({
        confidence: "blocked" as const,
        reason: `Active project resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        nextSafeAction: "repair active project resolution before retrying the write",
        recoveryAction: "repair-active-project-resolution-before-write",
      }));
      const ambiguityReason = shouldBlockWriteForAmbiguousResolution(
        resolution?.confidence,
        event.toolName,
        input,
        resolution?.reason,
        {
          nextSafeAction: resolution?.nextSafeAction,
          recoveryAction: resolution?.recoveryAction,
          cwd: ctx.cwd,
        },
      );
      if (ambiguityReason) return { block: true, reason: ambiguityReason };
    }
    const sprintReason = shouldBlockSprintStatusMutation(state, ctx.cwd, event.toolName, input);
    if (sprintReason) return { block: true, reason: sprintReason };
    const storyReason = shouldBlockStoryDoneMutation(state, ctx.cwd, event.toolName, input);
    if (storyReason) return { block: true, reason: storyReason };
    const planningReason = shouldBlockMutationInPlanning(state, ctx.cwd, event.toolName, input);
    if (planningReason) return { block: true, reason: planningReason };
  });

  pi.on("session_start", async (_event, ctx) => {
    const state = loadState(ctx.cwd);
    if (state.active) {
      ctx.ui.setStatus("bmad-runtime", ctx.ui.theme.fg(isAutonomousPhase(state) ? "warning" : "accent", `BMAD ${state.phase}`));
    }
  });
}
