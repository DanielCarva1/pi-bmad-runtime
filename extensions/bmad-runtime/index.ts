import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findCatalogRow, loadBmadCatalog } from "./catalog.js";
import { shouldBlockMutationInPlanning } from "./gates.js";
import { loadPathConfig } from "./paths.js";
import { recommendNext, summarizeCompletion } from "./scanner.js";
import { activateState, deactivateState, isAutonomousPhase, loadState, saveState, setPhase, type RuntimePhase } from "./state.js";
import { commandHelp, formatRecommendation, formatState } from "./ui.js";

const VALID_PHASES: RuntimePhase[] = ["0-init", "1-analysis", "2-planning", "3-solutioning", "4-implementation", "anytime"];

function kickoffPrompt(): string {
  return `/skill:bmad-runtime-for-pi start interview

You are now inside BMAD Runtime for Pi. Start the orchestrator interview. First determine whether this is a new product, an existing project, a quick-flow change, full BMAD Method, Enterprise, or custom module path. Use Portuguese unless project config says otherwise.`;
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

async function sendWorkflowInvocation(args: string, ctx: any, prompt: string): Promise<boolean> {
  if (ctx.hasUI && typeof ctx.newSession === "function") {
    const ok = await ctx.ui.confirm("BMAD fresh session", `Launch ${args} in a fresh Pi session? BMAD recommends a fresh context per workflow.`);
    if (ok) {
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile?.(),
        withSession: async (nextCtx: any) => {
          await nextCtx.sendUserMessage(prompt);
        },
      });
      return true;
    }
  }
  // Fallback: same session.
  ctx.ui.notify("Launching BMAD workflow in current session.", "warning");
  return false;
}

export default function bmadRuntimeExtension(pi: ExtensionAPI): void {
  pi.registerCommand("bmad", {
    description: "BMAD Runtime for Pi: stateful BMAD orchestration, gates, and workflow launch",
    getArgumentCompletions(prefix: string) {
      const items = ["start", "status", "next", "run", "phase", "autonomous", "interview", "exit", "help"];
      return items.filter((item) => item.startsWith(prefix)).map((item) => ({ value: item, label: item }));
    },
    handler: async (rawArgs, ctx) => {
      const args = rawArgs.trim();
      const [cmd = "status", ...rest] = args.split(/\s+/).filter(Boolean);
      let state = loadState(ctx.cwd);

      if (cmd === "help" || cmd === "--help" || cmd === "-h") {
        ctx.ui.notify(commandHelp(), "info");
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

      if (cmd === "autonomous") {
        state = saveState(ctx.cwd, { ...state, active: true, mode: "autonomous", phase: state.phase === "1-analysis" || state.phase === "2-planning" || state.phase === "0-init" ? "3-solutioning" : state.phase });
        pi.appendEntry("bmad-runtime-state", state);
        ctx.ui.notify(`BMAD autonomous mode enabled.\n${formatState(state)}`, "warning");
        return;
      }

      if (cmd === "interview") {
        state = saveState(ctx.cwd, { ...state, active: true, mode: "interview", phase: state.phase === "3-solutioning" || state.phase === "4-implementation" ? "2-planning" : state.phase });
        pi.appendEntry("bmad-runtime-state", state);
        ctx.ui.notify(`BMAD interview mode enabled.\n${formatState(state)}`, "info");
        return;
      }

      if (cmd === "status" || cmd === "next" || cmd === "") {
        const { catalog, rec } = loadRecommendation(ctx.cwd);
        const summary = summarizeCompletion(rec.completions);
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
          "",
          formatRecommendation(rec),
        ].join("\n");
        pi.sendMessage({ customType: "bmad-runtime", content: text, display: true }, { triggerTurn: false });
        return;
      }

      if (cmd === "run") {
        const token = rest.join(" ").trim();
        if (!token) {
          ctx.ui.notify("Usage: /bmad run <menu-code-or-skill>", "error");
          return;
        }
        const { catalog } = loadRecommendation(ctx.cwd);
        const row = findCatalogRow(catalog.rows, token);
        const skill = row?.skill ?? token.replace(/^\/+/, "");
        state = saveState(ctx.cwd, { ...activateState(state), currentWorkflow: skill, phase: (row?.phase as RuntimePhase | undefined) ?? state.phase });
        pi.appendEntry("bmad-runtime-state", state);
        const prompt = `/skill:${skill}\n\nBMAD Runtime target workflow: ${row ? `${row.displayName} (${row.menuCode})` : skill}. Follow the workflow exactly. Runtime mode is ${state.mode}; phase is ${state.phase}.`;
        const launchedInFreshSession = await sendWorkflowInvocation(skill, ctx, prompt);
        if (!launchedInFreshSession) pi.sendUserMessage(prompt);
        return;
      }

      ctx.ui.notify(`Unknown /bmad command: ${cmd}\n\n${commandHelp()}`, "error");
    },
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const state = loadState(ctx.cwd);
    if (!state.active) return;
    const { rec } = loadRecommendation(ctx.cwd);
    const stateText = formatState(state);
    const recommendationText = formatRecommendation(rec);
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
    const reason = shouldBlockMutationInPlanning(state, ctx.cwd, event.toolName, event.input as Record<string, unknown>);
    if (reason) return { block: true, reason };
  });

  pi.on("session_start", async (_event, ctx) => {
    const state = loadState(ctx.cwd);
    if (state.active) {
      ctx.ui.setStatus("bmad-runtime", ctx.ui.theme.fg(isAutonomousPhase(state) ? "warning" : "accent", `BMAD ${state.phase}`));
    }
  });
}
