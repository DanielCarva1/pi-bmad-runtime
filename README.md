# BMAD Runtime for Pi

BMAD Runtime for Pi turns BMAD Method from prompt-only guidance into a stateful Pi package: slash commands, persistent workflow state, BMAD phase gates, and an orchestrator context that keeps planning interactive and implementation autonomous.

## Status

Early local package. This repository contains Pi-native BMAD Runtime package resources only.

- Repository: `https://github.com/DanielCarva1/pi-bmad-runtime`
- Install mode: Pi project-local package, usually via pinned Git tag.

## What the package contains

Package-owned resources shipped with this package:

- `extensions/bmad-runtime/index.ts` - Pi extension entrypoint for `/bmad` commands, runtime context injection, and gates.
- `extensions/bmad-runtime/*.ts` - runtime state, catalog scanning, recommendation, sprint/story validators, paths, gates, and UI formatting.
- `skills/bmad-runtime-for-pi/` - orchestrator skill.
- `skills/grill-with-docs/` - bundled planning pressure-test skill.
- `prompts/` - prompt templates for common BMAD runtime actions.
- `docs/` - package design, PRD, architecture, epics, implementation plan, and autonomy contract.

Generated host-project artifacts are **not** package resources. They live in the project where the package is installed, for example:

- `.bmad-runtime/` - project-local runtime state, identity, baseline and recovery data.
- `_bmad/` - installed BMAD configuration/catalog files.
- `_bmad-output/` - project artifacts, ledgers, evidence, stories, sprint status and decisions.
- `.pi/settings.json` - project-local Pi package settings when installed with `pi install -l`.

## Install

Pi supports npm, git and local-path packages. Project-local installs use `-l` so the package is written to the current project `.pi/settings.json` instead of user settings.

### Git install - recommended for teammates

Use a pinned release tag when installing from GitHub:

```bash
pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.2
```

If the repository is private, make sure the teammate has collaborator/member access first.

### Local path install - only after cloning this package repo

Use this only if `pi-bmad-runtime` has already been cloned next to the target project:

```bash
pi install -l ../pi-bmad-runtime
```

Try a cloned local package for one session without changing settings:

```bash
pi -e ../pi-bmad-runtime
```

### Git install details

Use a pinned ref when installing from git:

```bash
pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.2
```

During private development, use the appropriate HTTPS or SSH repository URL and pin a tag or commit. Pi will clone to `.pi/git/` for project-local installs.

### npm-style install

This package is prepared for npm-style packaging, but this story does **not** publish it. Once published, install with:

```bash
pi install -l npm:pi-bmad-runtime@0.2.2
```

Until publication, validate the package shape locally:

```bash
npm pack --dry-run
```

## Commands

```text
/bmad-start           Start BMAD Runtime with a conversational project picker
/bmad                 Show runtime status or run BMAD subcommands
/bmad init            Initialize project-local runtime state, identity, baseline lock, and artifact folders
/bmad init --record-evidence    Initialize and append a command evidence packet
/bmad health          Diagnose package, BMAD config, state, artifacts, agents, and optional adapters
/bmad health --record-evidence  Run health and append a command evidence packet
/bmad readiness       Show implementation readiness gate card
/bmad transition      Show accept/review/cancel confirmation for the next BMAD transition
/bmad start           Same as /bmad-start
/bmad status          Show state, artifacts, gates, adapters, config, sprint status, and next candidate workflow
/bmad next            Show the next BMAD workflow recommendation
/bmad run <code>      Launch a workflow by menu code or skill name, usually in a fresh session
/bmad run next        Launch the next recommended required workflow
/bmad run --same-session <code>  Launch without fresh-session handoff
/bmad run --fresh <code>         Launch in a fresh session without confirmation
/bmad phase <phase>   Set phase manually: 1-analysis, 2-planning, 3-solutioning, 4-implementation, 5-ready-for-use
/bmad review <story>  Run Blind Hunter, Edge Case Hunter and Acceptance Auditor review roles; writes review evidence
/bmad handoff [note]  Write a compact resume handoff for the next session
/bmad interview       Switch back to human-in-loop interview mode
/bmad grill [target]  Run grill-with-docs against current plan or target
/bmad exit            Deactivate the runtime lock
/bmad help            Show contextual stage + command help
/bmad-help             Show contextual stage, next step and framework commands
```

## Quickstart examples

Before starting, pick the workspace intentionally. The Runtime Package, Runtime Home registry, and selected Project Workspace are separate roots. See `docs/self-hosting-isolation.md` when developing this package while also using it for other projects.

### New dedicated project workspace

```bash
pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.2
pi
# inside Pi
/bmad-start
```

Then open Pi in the created workspace and continue:

```bash
cd <created-workspace>
pi
# inside Pi
/bmad-start
/bmad-help
```

When the user chooses a new project in `/bmad-start`, the runtime writes project-local `.pi/settings.json` in the created workspace so the runtime package is available there. If package propagation is unavailable, the command output will say so and show the package install step.

### Existing BMAD project

```bash
pi install -l ../pi-bmad-runtime
pi
# inside Pi
/bmad-start
/bmad-help
/bmad status
/bmad next
```

Use `/bmad init` only as an explicit repair/reconcile command when `/bmad-start` reports missing local runtime state or unsafe project resolution.

### Automatic Phase 3/4

After PRD, UX, architecture, epics/stories and readiness pass:

```text
/bmad-start
```

The start/resume bootstrap selects the next non-human-blocked BMAD action from runtime state, handoff, artifacts and `sprint-status.yaml`: create story, dev story, code review, readiness recovery, or complete. For active story work it emits an execution plan that requires concrete story ACs, local checks, parallel review evidence, patch/decision gating, and sprint/state/ledger evidence before done status.

### Start mode examples

Detailed examples are included in the package:

- `examples/existing-bmad-workspace.md`
- `examples/generic-git-repo.md`
- `examples/local-only-workspace.md`
- `examples/moved-workspace-rebind.md`
- `examples/ambiguous-project-picker.md`

Parallel review can also be invoked explicitly:

```text
/bmad review 5-3-parallel-review-roles-produce-independent-findings
```

When `@gotgenes/pi-subagents` is loaded, the runtime uses its published service to spawn independent reviewer agents for Blind Hunter, Edge Case Hunter and Acceptance Auditor. If the service is unavailable, the runtime writes degraded evidence and does not claim independent review execution.

## Teammate handoff

Send a teammate the repository URL and tell them to install it as a project-local Pi package from inside the project they want to run BMAD in:

```bash
cd <their-project>
pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.2
pi
```

Then, inside Pi:

```text
/bmad-start
/bmad-help
```

If `/bmad-start` is treated as normal chat text, run `pi list` from the same folder. Keep only one `pi-bmad-runtime` package source visible for that session, then restart Pi. Duplicate user-level and project-level installs make Pi expose suffixed commands such as `/bmad-start:1` instead of the canonical `/bmad-start`.

For private repositories, the teammate must have GitHub access first. If their machine uses SSH-only GitHub access, they can install with:

```bash
pi install -l git:git@github.com:DanielCarva1/pi-bmad-runtime@v0.2.2
```

## Validate package shape

Run from this repository:

```bash
npm run audit:objective
npm run audit:context
npm run audit:release
npm run status:scope
npm run status:publication
npm run status:owner-release
npm run typecheck
npm test
npm run smoke
npm pack --dry-run
```

After the v0.2.2 tag is pushed, run:

```bash
npm run audit:objective:remote
```

`npm pack --dry-run` should include package resources (`extensions/`, `skills/`, `prompts/`, `docs/`, README and package metadata) and exclude generated or local-only state such as `node_modules/`, `.pi/`, `.bmad-runtime/`, `.git/`, env files, logs and host-project `_bmad-output/` artifacts.

## Design thesis

BMAD works because it creates context progressively:

1. Phase 1 analysis sharpens the idea.
2. Phase 2 planning turns it into requirements.
3. Phase 3 solutioning makes technical decisions explicit.
4. Phase 4 implementation executes story-by-story with review gates.
5. Phase 5 ready-for-use keeps the product usable without continuing the story loop indefinitely.

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
- **Phase 5:** active but not autonomous implementation. The runtime supports use, release/install validation, monitoring, incidents, or explicit next-version intake.

See `docs/autonomy-contract.md`.

## Security note

Pi packages run with local system access. Review package source before installation. This runtime does not require credentials for core local operation and must not publish, deploy, or perform external writes without explicit confirmation.
