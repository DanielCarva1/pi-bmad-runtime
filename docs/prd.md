# PRD — BMAD Runtime for Pi

## 1. Product Summary

BMAD Runtime for Pi is a Pi package that makes BMAD Method operationally enforceable inside the Pi coding agent. It adds a `/bmad` command, persistent runtime state, workflow routing, phase-aware guardrails, and orchestrator instructions that preserve BMAD discipline across context windows.

The runtime is not a replacement for BMAD Method. It is an execution harness around BMAD skills and artifacts.

## 2. Problem

BMAD Method depends on strict sequencing and artifact discipline:

- fresh chat per workflow;
- step-file execution without skipping;
- artifacts as source of truth;
- code review before `done`;
- phase gates before autonomous implementation.

When BMAD is implemented only through prompts, the model can drift, forget the phase, skip a workflow, accept user shortcuts, or pollute implementation with unresolved product ambiguity.

## 3. Goals

1. Provide a single `/bmad` entrypoint for BMAD inside Pi.
2. Keep BMAD state outside the chat in `.bmad-runtime/state.json`.
3. Detect installed BMAD catalog data from `_bmad/_config/bmad-help.csv`.
4. Recommend next workflows from phase, requirements, dependencies, and artifacts.
5. Start Phase 1/2 as an interview-led facilitation process.
6. Integrate `grill-with-docs` to challenge vague domain language and decisions.
7. Shift Phase 3/4 into autonomous execution mode with strict BMAD gates.
8. Provide a Phase 5 ready-for-use state so completed products do not stay in the Phase 4 story loop.
9. Make future subagent orchestration straightforward.

## 4. Non-Goals for MVP

- Reimplementing BMAD workflows.
- Replacing BMAD installer.
- Publishing to npm.
- Full artifact semantic validation.
- Full background multi-process autonomous sprint runner.
- GUI beyond Pi's TUI status/message surfaces.

## 5. Users

- Solo builder using Pi and BMAD to turn product ideas into working software.
- Technical lead who wants AI-assisted planning but autonomous technical execution.
- Team experimenting with agentic SDLC workflows.

## 6. Core User Flow

### 6.1 Start

User runs:

```text
/bmad-start
```

The runtime:

1. creates or loads `.bmad-runtime/state.json`;
2. scans for `_bmad/` and `_bmad-output/`;
3. invokes the `bmad-runtime-for-pi` start router;
4. asks whether to continue an existing BMAD project or create a new one;
5. activates state only after the selected project path is clear.

### 6.2 Phase 1/2 Interactive Facilitation

The orchestrator:

- asks strong questions;
- uses brainstorming/research/brief/PRFAQ/PRD workflows;
- calls `grill-with-docs` when terms, domain concepts, or decisions are vague;
- refuses to let weak assumptions pass silently;
- writes artifacts to BMAD output folders.

### 6.3 Phase 3/4 Autonomous Execution

After planning artifacts pass readiness:

1. runtime enters autonomous mode from `/bmad-start`/resume;
2. architecture, epics, sprint plan, stories, implementation, review, and QA run without routine user interruption;
3. the runtime asks the user only for blockers declared in the autonomy contract.

### 6.4 Phase 5 Ready for Use

After Phase 4 completion and release/install evidence are captured, the runtime may move to `5-ready-for-use`.

In this phase the project remains active, but Phase 4 story automation stops unless a new version, story, regression, incident, or support task is explicitly opened.

## 7. Acceptance Criteria

### AC1 — Local Pi Package

Given a local repo containing this package, when a user runs `pi install -l <path>`, then Pi discovers the `/bmad` command and bundled skills for that project.

### AC2 — Runtime State

Given `/bmad-start` or `/bmad start`, when the command runs, then the Pi agent asks whether to continue an existing BMAD project or create a new one.

Given the user chooses an existing uniquely resolved project, then `.bmad-runtime/state.json` is activated with mode, phase, and timestamps.

### AC3 — BMAD Catalog Detection

Given a project with `_bmad/_config/bmad-help.csv`, when `/bmad status` runs, then the command reports installed BMAD rows, required incomplete workflows, and next recommendation.

### AC4 — Orchestrator Bootstrap

Given the runtime is activated for an existing project, then the next agent turn receives the `bmad-runtime-for-pi` skill with a compact resume bootstrap based on project identity, runtime state, and the latest handoff if present.

Given the user chooses a new project, then the dedicated workspace receives project-local `.pi/settings.json` pointing at this runtime package whenever the package root/spec is available.

Given the runtime is active, when an agent loop ends or `/bmad handoff` is run, then `.bmad-runtime/handoffs/latest-handoff.md` is updated with a compact project anchor, next step, and resume rules.

### AC4b — Artifact Lifecycle

Given a consumer project has temporary task docs or agent work packets, then the runtime may allow cleanup only after the task outcome, changed files, checks, and next status are captured in sprint/status/evidence.

Given an artifact is canonical engine/runtime state, PRD, architecture, epics, story, sprint status, evidence, registry, baseline, or handoff, then it is not treated as ephemeral unless an explicit approved cleanup or migration workflow owns that change.

### AC5 — Lock Context

Given runtime state is active, when any agent turn starts, then hidden context reminds the model that BMAD runtime is active, artifacts are source of truth, and escaping the flow requires explicit `/bmad exit`.

### AC6 — Phase-Aware Gates

Given runtime state is active in Phase 1 or 2, when the model attempts `write` or `edit` outside planning/artifact/doc paths, then the tool call is blocked with a BMAD planning-phase explanation.

### AC7 — Workflow Launch

Given `/bmad run CP`, when catalog row `CP` exists, then the runtime launches the matching BMAD skill, preferring a fresh session.

### AC8 — Grill-With-Docs Availability

Given the package is installed, when the user or orchestrator invokes `/skill:grill-with-docs`, then the bundled Matt Pocock skill loads.

## 8. Risks

- Artifact completion detection can be heuristic and may misread unusual file names.
- Over-aggressive tool gates can block legitimate planning document edits.
- Fresh-session workflow handoff depends on Pi command context behavior.
- Autonomous Phase 3/4 needs stronger story/status validators before it can be trusted for long unattended runs.

## 9. MVP Cut

The first implementation ships:

- package manifest;
- `/bmad` extension command;
- state file;
- catalog scanner;
- status/next/run/start/exit;
- hidden runtime context;
- basic planning-phase mutation gate;
- orchestrator skill;
- bundled `grill-with-docs` skill.
