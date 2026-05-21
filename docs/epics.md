# Epics — BMAD Runtime for Pi

## Epic 1: Local Runtime Foundation

Goal: make BMAD Runtime installable as a local Pi package with a working `/bmad` command and persistent state.

### Story 1.1: Package skeleton

As a Pi user, I want a local package manifest so Pi can discover the extension, skills, and prompts.

Acceptance criteria:

- Given the package path, when Pi loads it, then the extension entrypoint is discoverable.
- Given the package path, when `npm pack --dry-run` runs, then expected extension, skills, prompts, and docs are included.

### Story 1.2: Runtime state

As an orchestrator, I want runtime state outside chat so BMAD phase and mode survive context resets.

Acceptance criteria:

- Given `/bmad start`, when invoked, then `.bmad-runtime/state.json` is created.
- Given existing state, when `/bmad status` runs, then state is displayed.
- Given `/bmad exit`, when invoked, then `active` becomes false.

### Story 1.3: BMAD catalog scanner

As an orchestrator, I want to read `_bmad/_config/bmad-help.csv` so recommendations come from the installed BMAD module.

Acceptance criteria:

- Given a valid BMAD catalog, scanner parses rows with phase, menu code, skill, dependencies, and required flag.
- Given no catalog, status reports missing catalog without crashing.

## Epic 2: Guided Planning and Grill Gates

Goal: make Phase 1/2 a strong interview system with explicit domain-language pressure testing.

### Story 2.1: Orchestrator skill

As a user, I want `/bmad start` to activate a strict BMAD orchestrator that interviews me and recommends a track.

Acceptance criteria:

- Given `/bmad start`, the orchestrator introduces BMAD Runtime and asks for project goal/track signals.
- The orchestrator does not invent a Hermes persona.
- The orchestrator distinguishes Quick Flow, BMad Method, Enterprise, and custom paths.

### Story 2.2: Grill-with-docs command

As a user, I want `/bmad grill` to pressure-test the current plan against docs and domain language.

Acceptance criteria:

- Given `/bmad grill`, the runtime invokes `grill-with-docs`.
- Given a target argument, the target is passed to the skill.
- Given no target, the skill is asked to inspect the current BMAD plan/artifacts.

### Story 2.3: Planning mutation gate

As a runtime, I want to prevent accidental source mutations during Phase 1/2.

Acceptance criteria:

- Given active state in Phase 1/2, write/edit outside BMAD artifacts/docs is blocked.
- Given active state in Phase 3/4, source mutation is not blocked by the planning gate.

## Epic 3: Workflow Routing

Goal: make `/bmad next` and `/bmad run <code>` reliably route workflows.

### Story 3.1: Recommendation engine

As a user, I want `/bmad next` to show the next required BMAD workflow and optional same-phase workflows.

Acceptance criteria:

- Required incomplete workflows are sorted by phase.
- Dependencies from `after` are respected where possible.
- Completion evidence is listed heuristically.

### Story 3.2: Fresh-session workflow launch

As a BMAD user, I want `/bmad run CP` to launch the matching skill in a fresh session when possible.

Acceptance criteria:

- Menu codes map to catalog rows.
- Skill names can be used directly.
- The user is prompted for fresh-session launch in interactive mode.
- Same-session fallback works.

## Epic 4: Autonomous Phase 3/4 Runner

Goal: move solutioning and implementation into autonomous orchestration while preserving BMAD gates.

### Story 4.1: Sprint status validator

As a runtime, I want to parse `sprint-status.yaml` so story progression can be validated.

Acceptance criteria:

- Legal statuses are recognized.
- Runtime detects next backlog, ready-for-dev, in-progress, review, and done stories.
- Runtime warns on illegal transitions.

### Story 4.2: Done gate validator

As a runtime, I want to block `done` until implementation, tests, review, and story records are complete.

Acceptance criteria:

- Story file status and sprint status are cross-checked.
- Unresolved review findings prevent done.
- Missing file list/dev record prevents done.

### Story 4.3: Autopilot loop

As a user, I want `/bmad autopilot` to continue Phase 3/4 until completion or a true blocker.

Acceptance criteria:

- Runtime runs next required workflow.
- Runtime continues create-story → dev-story → review loop.
- Runtime stops only on autonomy-contract blockers or completion.

## Epic 5: Subagent Orchestration

Goal: use isolated Pi subagents for independent review and heavy analysis.

### Story 5.1: Delegate tool

As an orchestrator, I want a `bmad_delegate` tool to spawn specialist subagents.

Acceptance criteria:

- Single, parallel, and chain modes are supported or delegated to the Pi subagent package.
- Project-local subagent definitions require trust confirmation.

### Story 5.2: Review subagents

As a runtime, I want Blind Hunter, Edge Case Hunter, and Acceptance Auditor to run independently.

Acceptance criteria:

- Each reviewer receives the correct context boundary.
- Reviews run in parallel where possible.
- Findings are deduplicated and classified.

### Story 5.3: Architecture and story compiler subagents

As a runtime, I want heavy context compilation and architecture critique to happen off the main context window.

Acceptance criteria:

- Story context compiler creates focused context artifacts.
- Architecture critic challenges hard-to-reverse decisions.
- Outputs are persisted as BMAD artifacts.
