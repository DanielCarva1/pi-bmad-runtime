import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatPackageAdapters, scanPackageAdapters } from "./adapters.js";
import { formatArtifactRegistry, scanArtifactRegistry } from "./artifacts.js";
import { buildAutopilotExecutionPlan, formatAutopilotRecommendation, recommendPhase4Autopilot } from "./autopilot.js";
import { findCatalogRow, loadBmadCatalog, type BmadCatalogRow } from "./catalog.js";
import { formatConfigValidation, validateRuntimeConfig } from "./config.js";
import { recordRuntimeEvidence } from "./evidence.js";
import { shouldBlockDangerousToolCall, shouldBlockMutationInPlanning, shouldBlockSprintStatusMutation, shouldBlockStoryDoneMutation } from "./gates.js";
import { formatGrillClosureRecommendation, recommendGrillClosure } from "./grill.js";
import { formatHealthReport, runHealthCheck } from "./health.js";
import { formatLedgerSummary, summarizeLedger } from "./ledger.js";
import { loadPathConfig } from "./paths.js";
import { ensureProjectInitialized, formatProjectInitResult } from "./project.js";
import { evaluateReadinessGate, formatGateCard } from "./readiness.js";
import { formatReviewRunResult, runParallelReviewDelegation } from "./review.js";
import { recommendNext, summarizeCompletion } from "./scanner.js";
import { loadSprintStatus, summarizeSprint, validateSprintDocument } from "./sprint.js";
import { scanStoryStatusFiles } from "./story.js";
import { activateState, deactivateState, isAutonomousPhase, loadState, recordWorkflowLaunch, saveState, setPhase, type RuntimePhase } from "./state.js";
import { formatTransitionPrompt } from "./transition.js";
import { commandHelp, formatRecommendation, formatRuntimeHelp, formatState } from "./ui.js";

const VALID_PHASES: RuntimePhase[] = ["0-init", "1-analysis", "2-planning", "3-solutioning", "4-implementation", "anytime"];

function kickoffPrompt(): string {
  return `/skill:bmad-runtime-for-pi start interview

You are now inside BMAD Runtime for Pi. Start the orchestrator interview with a Trail Familiarity Check:
1. Ask whether the user already knows the BMAD track/module they want.
2. If yes, accept only valid planning tracks (Quick Flow, BMad Method, Enterprise) or installed/official module trails (core, bmm, bmb, cis, gds, tea).
3. If no, summarize the options briefly in natural language and recommend a route from the user's intent.
4. Ask for the product/project goal if it is not already clear.
Do not require the user to memorize slash commands. Do not invent Hermes, Zed, ACP, or PMS-specific paths. Use the user's current language unless project config says otherwise.`;
}

function runtimeContext(stateText: string, recommendationText: string): string {
  return `[BMAD RUNTIME FOR PI ACTIVE]

Runtime state:
${stateText}

${recommendationText}

Operating rules:
- You are the orchestrator. Do not invent a separate Hermes persona.
- BMAD artifacts and runtime state are source of truth, not chat memory.
- Phase 1/2 are human-in-loop interview and planning phases: ask hard questions, use grill-with-docs for terminology/decision pressure, and do not mutate product code.
- Phase 3/4 are autonomous by default: execute BMAD workflows without routine user involvement, asking only for true blockers from the autonomy contract.
- Free-form user questions are allowed, but keep the BMAD anchor visible: current project, mode/phase, current workflow, and next trail step when relevant.
- Free exploration is not gate approval. Canonical artifact promotion, phase advancement, readiness, waiver, or done status requires explicit artifact/gate evidence.
- Do not escape BMAD Runtime unless the user explicitly runs /bmad exit.
- Prefer fresh context windows for workflow runs.
[/BMAD RUNTIME FOR PI ACTIVE]`;
}

function loadRecommendation(cwd: string) {
  const catalog = loadBmadCatalog(cwd);
  const cfg = loadPathConfig(cwd);
  const rec = recommendNext(catalog.rows, cfg);
  return { catalog, cfg, rec };
}



function formatRuntimeRecommendation(cwd: string, state = loadState(cwd)): string {
  const { cfg, rec } = loadRecommendation(cwd);
  const sprint = loadSprintStatus(cfg);
  if (state.phase === "4-implementation" && sprint.doc) return formatAutopilotRecommendation(recommendPhase4Autopilot(sprint.doc, cfg));
  return formatRecommendation(rec);
}

function buildRuntimeHelpContent(cwd: string, state = loadState(cwd)): string {
  const { catalog, cfg, rec } = loadRecommendation(cwd);
  const sprint = loadSprintStatus(cfg);
  const phase4Autopilot = state.phase === "4-implementation" && sprint.doc ? recommendPhase4Autopilot(sprint.doc, cfg) : undefined;
  return formatRuntimeHelp({ state, recommendation: rec, catalogRows: catalog.rows, phase4Autopilot });
}

type FreshLaunchMode = "ask" | "always" | "never";

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

async function sendWorkflowInvocation(args: string, ctx: any, prompt: string, fresh: FreshLaunchMode): Promise<boolean> {
  if (fresh === "never") {
    ctx.ui.notify("Launching BMAD workflow in current session.", "warning");
    return false;
  }

  if (typeof ctx.newSession === "function") {
    const shouldLaunchFresh =
      fresh === "always" ||
      (ctx.hasUI && (await ctx.ui.confirm("BMAD fresh session", `Launch ${args} in a fresh Pi session? BMAD recommends a fresh context per workflow.`)));
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

export default function bmadRuntimeExtension(pi: ExtensionAPI): void {

  pi.registerCommand("bmad-help", {
    description: "Show contextual Pi+BMad stage, next step, and command help",
    handler: async (_rawArgs, ctx) => {
      pi.sendMessage({ customType: "bmad-runtime-help", content: buildRuntimeHelpContent(ctx.cwd), display: true }, { triggerTurn: false });
    },
  });

  pi.registerCommand("bmad", {
    description: "BMAD Runtime for Pi: stateful BMAD orchestration, gates, and workflow launch",
    getArgumentCompletions(prefix: string) {
      const items = ["init", "health", "readiness", "transition", "start", "status", "next", "run", "phase", "autonomous", "autopilot", "review", "interview", "grill", "exit", "help"];
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
        const result = ensureProjectInitialized(ctx.cwd);
        state = loadState(ctx.cwd);
        pi.appendEntry("bmad-runtime-init", result);
        pi.appendEntry("bmad-runtime-state", state);
        const recordEvidence = rest.includes("--record-evidence") || rest.includes("--evidence");
        const evidence = recordEvidence
          ? recordRuntimeEvidence(ctx.cwd, {
              command: "/bmad init",
              outcome: "ok",
              summary: "Project initialization completed.",
              touchedPaths: [...result.created, ...result.reused, ...result.skipped],
              counts: { created: result.created.length, reused: result.reused.length, skipped: result.skipped.length },
              details: { projectId: result.identity.projectId, baseline: result.baseline },
            })
          : undefined;
        ctx.ui.notify(`${formatProjectInitResult(result)}${evidence ? `\n\nEvidence: ${evidence.relativePath}` : ""}`, "info");
        return;
      }

      if (cmd === "health" || cmd === "doctor") {
        const report = runHealthCheck(ctx.cwd);
        pi.appendEntry("bmad-runtime-health", report);
        const recordEvidence = rest.includes("--record-evidence") || rest.includes("--evidence");
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
        state = saveState(ctx.cwd, activateState(state));
        pi.appendEntry("bmad-runtime-state", state);
        ctx.ui.notify(`BMAD Runtime activated.\n${formatState(state)}`, "info");
        pi.setSessionName?.("BMAD Runtime");
        pi.sendUserMessage(kickoffPrompt());
        return;
      }

      if (cmd === "exit" || cmd === "unlock" || cmd === "stop") {
        state = saveState(ctx.cwd, deactivateState(state));
        pi.appendEntry("bmad-runtime-state", state);
        ctx.ui.notify("BMAD Runtime deactivated.", "info");
        return;
      }

      if (cmd === "phase") {
        const phase = rest[0] as RuntimePhase | undefined;
        if (!phase || !VALID_PHASES.includes(phase)) {
          ctx.ui.notify(`Invalid phase. Use one of: ${VALID_PHASES.join(", ")}`, "error");
          return;
        }
        state = saveState(ctx.cwd, setPhase({ ...state, active: true }, phase));
        pi.appendEntry("bmad-runtime-state", state);
        ctx.ui.notify(`BMAD phase set.\n${formatState(state)}`, "info");
        return;
      }

      if (cmd === "autonomous" || cmd === "autopilot") {
        state = saveState(ctx.cwd, { ...state, active: true, mode: "autonomous", phase: state.phase === "1-analysis" || state.phase === "2-planning" || state.phase === "0-init" ? "3-solutioning" : state.phase });
        pi.appendEntry("bmad-runtime-state", state);
        ctx.ui.notify(`BMAD autonomous mode enabled.\n${formatState(state)}`, "warning");

        if (cmd === "autopilot") {
          const cfg = loadPathConfig(ctx.cwd);
          const sprint = loadSprintStatus(cfg);
          if (state.phase === "4-implementation" && sprint.doc) {
            const auto = recommendPhase4Autopilot(sprint.doc, cfg);
            const plan = buildAutopilotExecutionPlan(auto);
            pi.sendMessage({ customType: "bmad-runtime", content: `${formatAutopilotRecommendation(auto)}

${plan.prompt}`, display: true }, { triggerTurn: false });
            if (auto.action === "complete" || auto.action === "blocked" || !auto.skill) return;
            state = saveState(
              ctx.cwd,
              recordWorkflowLaunch({ ...state, phase: "4-implementation", currentStory: auto.story?.key ?? state.currentStory }, {
                skill: auto.skill,
                displayName: auto.action,
                phase: "4-implementation",
                launchArgs: auto.story?.key ?? "",
              }),
            );
            pi.appendEntry("bmad-runtime-state", state);
            pi.sendUserMessage(plan.prompt);
            return;
          }

          const { catalog, rec } = loadRecommendation(ctx.cwd);
          const row = rec.row;
          if (!row) {
            pi.sendMessage({ customType: "bmad-runtime", content: "✅ BMAD autopilot found no incomplete required workflow.", display: true }, { triggerTurn: false });
            return;
          }
          const skill = row.skill;
          state = saveState(
            ctx.cwd,
            recordWorkflowLaunch({ ...state, phase: (row.phase as RuntimePhase | undefined) ?? state.phase }, {
              skill,
              displayName: row.displayName,
              menuCode: row.menuCode,
              phase: row.phase,
              launchArgs: rest.join(" ").trim(),
            }),
          );
          pi.appendEntry("bmad-runtime-state", state);
          const prompt = buildWorkflowPrompt(row, skill, state, rest.join(" ").trim());
          const launchedInFreshSession = await sendWorkflowInvocation(skill, ctx, prompt, catalog.exists ? "always" : "never");
          if (!launchedInFreshSession) pi.sendUserMessage(prompt);
        }
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

      if (cmd === "grill") {
        state = saveState(ctx.cwd, activateState(state));
        pi.appendEntry("bmad-runtime-state", state);
        const target = rest.join(" ").trim();
        const prompt = target
          ? `/skill:grill-with-docs ${target}`
          : "/skill:grill-with-docs Challenge the current BMAD plan or most relevant planning artifact against existing CONTEXT.md, ADRs, docs, and code. Ask one question at a time and update CONTEXT.md/ADRs only when decisions crystallize.";
        pi.sendUserMessage(prompt);
        return;
      }

      if (cmd === "interview") {
        state = saveState(ctx.cwd, { ...state, active: true, mode: "interview", phase: state.phase === "3-solutioning" || state.phase === "4-implementation" ? "2-planning" : state.phase });
        pi.appendEntry("bmad-runtime-state", state);
        ctx.ui.notify(`BMAD interview mode enabled.\n${formatState(state)}`, "info");
        return;
      }

      if (cmd === "status" || cmd === "next" || cmd === "") {
        const { catalog, cfg, rec } = loadRecommendation(ctx.cwd);
        const summary = summarizeCompletion(rec.completions);
        const artifacts = scanArtifactRegistry(cfg);
        const readiness = evaluateReadinessGate(cfg, artifacts);
        const grillClosure = recommendGrillClosure(state, artifacts);
        const adapters = scanPackageAdapters(ctx.cwd);
        const configIssues = validateRuntimeConfig(ctx.cwd, cfg);
        const ledger = summarizeLedger(state, cfg);
        const sprint = loadSprintStatus(cfg);
        const sprintStoryStatus = new Map(sprint.doc?.entries.filter((entry) => entry.kind === "story").map((entry) => [entry.key, entry.status]) ?? []);
        const storyFiles = scanStoryStatusFiles(cfg.implementation_artifacts);
        const storyMismatches = sprint.doc
          ? storyFiles.filter((story) => story.status && sprintStoryStatus.has(story.key) && sprintStoryStatus.get(story.key) !== story.status)
          : [];
        const sprintLines = sprint.doc
          ? [
              `Sprint status: ${sprint.path}`,
              `Sprint entries: ${sprint.doc.entries.length}`,
              `Sprint validation errors: ${validateSprintDocument(sprint.doc).filter((issue) => issue.severity === "error").length}`,
              `Sprint summary: ${JSON.stringify(summarizeSprint(sprint.doc))}`,
              `Story files detected: ${storyFiles.length}`,
              `Story/sprint status mismatches: ${storyMismatches.length}`,
              ...storyMismatches.slice(0, 5).map((story) => `Mismatch: ${story.key} story=${story.status} sprint=${sprintStoryStatus.get(story.key)}`),
            ]
          : [`Sprint status: ${sprint.exists ? `error: ${sprint.error}` : `not found at ${sprint.path}`}`];
        const phase4Autopilot = state.phase === "4-implementation" && sprint.doc ? recommendPhase4Autopilot(sprint.doc, cfg) : undefined;
        const text = [
          "# BMAD Runtime Status",
          "",
          "```text",
          formatState(state),
          "```",
          "",
          `BMAD catalog: ${catalog.exists ? catalog.path : "not found"}`,
          catalog.error ? `Catalog error: ${catalog.error}` : `Catalog rows: ${catalog.rows.length}`,
          `Heuristic completion: ${summary.complete}/${summary.total}`,
          ...sprintLines,
          "",
          formatArtifactRegistry(artifacts),
          "",
          formatGateCard(readiness),
          "",
          formatGrillClosureRecommendation(grillClosure),
          "",
          formatPackageAdapters(adapters),
          "",
          formatConfigValidation(configIssues),
          "",
          formatLedgerSummary(ledger),
          "",
          formatRecommendation(rec),
        ].join("\n");
        pi.sendMessage({ customType: "bmad-runtime", content: text, display: true }, { triggerTurn: false });
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
        state = saveState(
          ctx.cwd,
          recordWorkflowLaunch({ ...activateState(state), phase: (row?.phase as RuntimePhase | undefined) ?? state.phase }, {
            skill,
            displayName: row?.displayName,
            menuCode: row?.menuCode,
            phase: row?.phase ?? state.phase,
            launchArgs: parsed.extraArgs,
          }),
        );
        pi.appendEntry("bmad-runtime-state", state);
        const prompt = buildWorkflowPrompt(row, skill, state, parsed.extraArgs);
        const launchedInFreshSession = await sendWorkflowInvocation(skill, ctx, prompt, parsed.fresh);
        if (!launchedInFreshSession) pi.sendUserMessage(prompt);
        return;
      }

      ctx.ui.notify(`Unknown /bmad command: ${cmd}\n\n${commandHelp()}`, "error");
    },
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

  pi.on("tool_call", async (event, ctx) => {
    const state = loadState(ctx.cwd);
    const input = event.input as Record<string, unknown>;
    const dangerReason = shouldBlockDangerousToolCall(state, ctx.cwd, event.toolName, input);
    if (dangerReason) return { block: true, reason: dangerReason };
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
