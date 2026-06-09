# Agent Artifact Contract

Purpose: keep BMAD artifacts small, stable and easy for an agent to parse without loading long narrative context.

## Source Order

1. `.bmad-runtime/state.json`
2. `_bmad-output/**/sprint-status.yaml`
3. active story file
4. latest handoff
5. evidence files referenced by story/sprint
6. PRD, architecture and epics only when the active task needs missing scope

## Sprint Status

Use YAML as the compact project index.

Required shape:

```yaml
generated: 2026-06-09
last_updated: 2026-06-09
project: example-project

development_status:
  epic-1: in-progress
  1-1-first-story: ready-for-dev
  epic-1-retrospective: optional
```

Rules:

- one line per epic, story or retrospective;
- legal story states: `backlog`, `ready-for-dev`, `in-progress`, `review`, `done`;
- no prose under `development_status`;
- update `last_updated` whenever state changes.

## Story File

Use markdown with predictable headings. Keep narrative short and put operational facts in lists.

Required headings for an executable story:

```markdown
# Story 1.1: short-title

Status: ready-for-dev

## Story

As a <actor>, I want <capability>, so that <outcome>.

## Acceptance Criteria

1. Given <state> When <action> Then <observable result>

## Agent Scope

- Allowed paths: <paths>
- Dependencies: <story ids or none>
- Stop if: <blockers>

## Tasks / Subtasks

- [ ] <small task>

## Dev Agent Record

### Debug Log References

- <command> - <pass/fail>

### Completion Notes List

- <result>

### File List

- <path>

## Senior Developer Review (AI)

**Outcome:** <Approve|Patch Required|Decision Needed>
```

Rules:

- acceptance criteria must be concrete `Given/When/Then`;
- `Agent Scope` should name allowed paths, dependencies and stop conditions;
- `Dev Agent Record` is the only place for implementation notes;
- review findings must be checkbox items until resolved;
- do not mark `done` until checks, review, evidence, sprint status and runtime state are updated.

## Epic File

Use epics as compact dependency maps, not essays.

Recommended shape:

```markdown
# Epic 1: short outcome

## Outcome

- <observable capability>

## Stories

| Story | Status | Depends On | Purpose |
| --- | --- | --- | --- |
| 1.1 | ready-for-dev | none | <short purpose> |

## Constraints

- <architecture or product constraint>
```

## Ephemeral Task Packets

Temporary task docs are allowed only in consumer projects.

Recommended task-packet locations:

- `_bmad-output/task-packets/`
- `_bmad-output/work-packets/`
- `docs/task-packets/`

They may be deleted or archived after:

- result is captured;
- changed files are listed;
- checks are recorded;
- evidence is referenced;
- sprint/status next state is updated.

Canonical runtime, planning, story, sprint, handoff, registry, baseline and evidence artifacts are not ephemeral.

Runtime cleanup classification:

- protected canonical paths are blocked from task-packet cleanup;
- unknown paths are blocked until explicitly classified;
- task-packet paths are allowed only after the five completion facts above are captured.

## Context Budget

Before reading long artifacts, the agent should build a compact working set:

- BMAD anchor: project, phase, workflow, story, next step;
- sprint entry for current story;
- story `Acceptance Criteria`, `Agent Scope`, `Tasks / Subtasks`, `Dev Agent Record`;
- latest handoff excerpt;
- only the evidence files needed for the next gate.

If this set is not enough, load the smallest canonical artifact that resolves the question.

See `docs/context-budget.md` for package-level prompt and contract budgets.
