# BMAD Runtime for Pi

BMAD Runtime for Pi turns BMAD Method from prompt-only guidance into a stateful Pi package: slash commands, persistent workflow state, BMAD phase gates, and a strict orchestrator persona that keeps planning interactive and implementation autonomous.

## Status

Early local MVP. This repository is intentionally separate from `zico-os`.

- Repo: `C:/Daniel-D/AgentPlatformRepos/pi-bmad-runtime`
- Vault: `C:/Daniel-D/pi-bmad-runtime-vault`

## Install locally in Pi

From any project where you want the runtime available:

```bash
pi install C:/Daniel-D/AgentPlatformRepos/pi-bmad-runtime
```

Or try it for one session:

```bash
pi -e C:/Daniel-D/AgentPlatformRepos/pi-bmad-runtime
```

## Commands

```text
/bmad                 Start or show runtime status
/bmad start           Activate BMAD Runtime and start the orchestrator interview
/bmad status          Show state, detected BMAD installation, and next candidate workflow
/bmad next            Show the next BMAD workflow recommendation
/bmad run <code>      Launch a workflow by menu code or skill name, usually in a fresh session
/bmad phase <phase>   Set phase manually: 1-analysis, 2-planning, 3-solutioning, 4-implementation
/bmad autonomous      Switch to autonomous Phase 3/4 mode
/bmad autopilot       Alias for autonomous mode
/bmad interview       Switch back to human-in-loop interview mode
/bmad grill [target]  Run grill-with-docs against current plan or target
/bmad exit            Deactivate the runtime lock
/bmad help            Show command help
```

## Design thesis

BMAD works because it creates context progressively:

1. Phase 1 analysis sharpens the idea.
2. Phase 2 planning turns it into requirements.
3. Phase 3 solutioning makes technical decisions explicit.
4. Phase 4 implementation executes story-by-story with review gates.

Prompt-only BMAD can drift when the model loses context or skips steps. Pi can enforce more of the method in runtime:

- persistent state in `.bmad-runtime/state.json`;
- hidden per-turn BMAD operating context;
- slash-command routing via `/bmad`;
- basic tool gates during interactive planning;
- fresh-session workflow launches;
- bundled `grill-with-docs` skill for domain-language pressure testing.

## Human/autonomy policy

The runtime intentionally splits responsibility:

- **Phase 1/2:** human stays involved. The orchestrator asks hard questions, uses `grill-with-docs`, challenges assumptions, and documents decisions.
- **Phase 3/4:** autonomous by default. The orchestrator should only interrupt for true blockers: missing credentials, destructive irreversible choices, paid external actions, legal/compliance decisions, or contradictory approved artifacts.

See `docs/autonomy-contract.md`.
