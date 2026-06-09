# BMAD Runtime Agent Operating Contract

Purpose: give the Pi agent a compact runtime contract before reading long BMAD docs or large project artifacts.

## Source Order

1. Runtime state: `.bmad-runtime/state.json`
2. Latest handoff: `.bmad-runtime/handoffs/latest-handoff.md`, if present
3. Status artifacts: `sprint-status.yaml`, story files, readiness report, evidence
4. Canonical planning artifacts: PRD, UX, architecture, epics/stories
5. Full BMAD docs only when the active workflow needs a specific rule not covered above

Chat memory is never source of truth.

Use `docs/context-budget.md` to keep bootstrap prompts and compact contracts bounded.

## Start State Machine

| State | Input | Action | Exit |
| --- | --- | --- | --- |
| S0 Resolve | `/bmad-start` or `/bmad start` | Resolve current workspace and Runtime Home registry without mutation. | unique project, ambiguous picker, unsafe cwd, or new-project intent |
| S1 Ask | no explicit project choice | Ask one concise question: continue an existing project or create a new one. | user selects existing project or new project |
| S2 Continue | existing project selected | Activate state, read prior handoff, build compact resume bootstrap. | next agent turn receives project anchor and next step |
| S3 Create | new project selected | Ask only missing name/root/versioning details, create dedicated workspace. | workspace has identity, baseline, registry entry, and local Pi package settings when possible |
| S4 Execute | active project | Phase 1/2 interview or Phase 3/4 automatic execution. | blocker, workflow completion, handoff, or done gate |
| S5 Ready | Phase 5 | Keep the project active but stop Phase 4 story automation. | support, release smoke, monitoring, incident, or explicit next-version intake |

## Phase Policy

| Phase | Human input | Agent behavior | Stop only for |
| --- | --- | --- | --- |
| 1-analysis | high | Facilitate, challenge vague terms, create discovery artifacts. | product judgment, unclear goal, external research choice |
| 2-planning | high | Create/validate PRD and UX; compress routine confirmations. | scope decision, requirement contradiction, readiness blocker |
| 3-solutioning | low | Create architecture, epics/stories, readiness evidence automatically. | missing approved artifact, unsafe target repo write, irreversible choice |
| 4-implementation | low | Run story loop: create story, dev, checks, review, fix, evidence, status. | credentials, paid/external action, destructive operation, new scope, unresolved review |
| 5-ready-for-use | on demand | Product is usable; monitor, support, validate release/install, or start a new version explicitly. | incident, regression, new scope, external publication/action |

## Workspace Boundary

- Runtime Package: package source, skills, prompts, docs, tests and release metadata.
- Runtime Home: metadata-only registry, locks and cache.
- Project Workspace: `.bmad-runtime/`, `_bmad/`, `_bmad-output/`, `.pi/settings.json` and project code.

When self-hosting runtime development, keep the runtime package repository, runtime-development BMAD project, and consumer projects as separate anchors. Run `/bmad-start` in the intended workspace and let the picker continue an existing project or create a new dedicated workspace.

## Artifact Policy

Protected artifacts:

- runtime state, registry, baseline, project identity
- PRD, UX, architecture, epics/stories
- sprint status, story files, review evidence, handoffs

Ephemeral artifacts:

- temporary task packets and agent work notes in consumer projects
- disposable context compilations created only to execute one task

Ephemeral artifacts may be deleted or archived only after outcome, changed files, checks, evidence and next status are captured in protected artifacts.

Use `docs/agent-artifact-contract.md` for compact sprint, story, epic and context-budget rules before reading or creating long artifacts.

## Resume Rules

1. Report the BMAD anchor first: project, phase, mode, workflow, story, next step.
2. Read the handoff excerpt first; inspect full artifacts only when needed.
3. If handoff and runtime state disagree, trust runtime state and inspect protected artifacts.
4. Do not mix the runtime package repository with a consumer project workspace.
5. Do not ask for routine approvals in Phase 3/4.
6. Do not invent any separate automation command.
7. In Phase 5, do not resume Phase 4 story automation unless a new version/story is explicitly opened.

See `docs/self-hosting-isolation.md` if package development and consumer project work are happening at the same time.
