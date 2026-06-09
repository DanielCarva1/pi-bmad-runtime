# Self-Hosting and Workspace Isolation

Purpose: keep BMAD Runtime development, runtime metadata, and consumer project work from being mistaken for each other.

## Three Roots

| Root | Example | Owns | Must not own |
| --- | --- | --- | --- |
| Runtime Package | `pi-bmad-runtime/` | extension code, skills, prompts, package docs, package tests | consumer project PRDs, stories, sprint status, generated task packets |
| Runtime Home | `~/.pi/agent/bmad-runtime/` | registry, locks, operational metadata, cache | PRD, architecture, epics, stories, evidence, source code |
| Project Workspace | `guardinha-noturno/`, `pi-bmad-builder/`, or another selected project | `.bmad-runtime/`, `_bmad/`, `_bmad-output/`, `.pi/settings.json`, project code | package release tags, package source ownership |

The Runtime Package can be under active development while the runtime is also installed into other Project Workspaces. The selected Project Workspace is still the source of truth for the current BMAD project.

## Self-Hosting Rule

When developing the runtime with its own BMAD flow:

1. Keep package code in `pi-bmad-runtime/`.
2. Keep the BMAD project state that manages runtime development in its selected Project Workspace.
3. Keep consumer projects such as `guardinha-noturno` in separate Project Workspaces.
4. Run `/bmad-start` from the intended workspace, then let the project picker continue an existing project or create a new dedicated workspace.
5. Do not copy consumer `_bmad-output/`, sprint status, story files, or task packets into the Runtime Package.

If the current active project is the runtime itself, the BMAD state should say so explicitly. If the active project is a consumer project, the runtime package repository is only a package dependency.

## Install Modes

Maintainer local development, from the target Project Workspace:

```bash
pi install -l <path-to-pi-bmad-runtime>
pi
```

One-session local trial without changing project settings:

```bash
pi -e <path-to-pi-bmad-runtime>
```

Released teammate install, only after the release tag exists remotely:

```bash
pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.0
pi
```

The install command is run in the project that should receive BMAD Runtime. It should not be run inside `pi-bmad-runtime/` unless the package repository is intentionally being used as the active Project Workspace for runtime development.

## Start and Resume

`/bmad-start` and `/bmad start` are the normal entrypoints.

The agent should ask one concise question when project intent is missing:

- continue an existing project from registry/state/latest handoff; or
- create a new dedicated Project Workspace.

Phase 1/2 stays interview-led. Phase 3/4 should continue automatically until a true blocker, workflow completion, handoff, or done gate. Phase 5 is ready-for-use: keep the project active, but do not resume Phase 4 story automation unless a new version/story/incident/support task is explicit. There is no separate automation command.

## Artifact Lifecycle

Protected package artifacts:

- `extensions/`, `skills/`, `prompts/`, `docs/`, `examples/`, `scripts/`, `tests/`, package metadata.

Protected project artifacts:

- `.bmad-runtime/` state, identity, baseline and handoffs;
- `_bmad/` installed configuration and catalog files;
- `_bmad-output/` PRD, UX, architecture, epics, stories, sprint status, evidence and decisions.

Ephemeral consumer artifacts:

- temporary task packets;
- agent work notes;
- disposable context compilations created only to execute one task.

Ephemeral files may be deleted or archived only after the result, changed files, checks, evidence and next status are captured in protected project artifacts.

## Recovery Checklist

If the agent seems to be working on the wrong project:

1. Check the shell current directory before starting Pi.
2. Run `/bmad status` and compare the reported Project Workspace with the current directory.
3. Run `/bmad projects` or `/bmad-start` to use the picker instead of guessing.
4. Inspect project-local `.pi/settings.json` to confirm the package is installed in that workspace.
5. Inspect `~/.pi/agent/bmad-runtime/projects.json` only as registry metadata, not as project truth.
6. Open Pi in the intended workspace and run `/bmad-start` again if the selected project is wrong.

Chat memory is never source of truth. Runtime state, sprint status, latest handoff and protected artifacts decide the current project anchor.
