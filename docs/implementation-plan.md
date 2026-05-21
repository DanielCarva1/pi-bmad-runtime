# Implementation Plan

## Milestone 1 — Local Runtime MVP

- [x] Separate repository and vault.
- [x] Pi package manifest.
- [x] Architecture/PRD/autonomy docs.
- [x] `/bmad` extension command.
- [x] Persistent state file.
- [x] BMAD catalog scanner.
- [x] Status and next recommendation.
- [x] Hidden runtime context injection.
- [x] Basic planning-phase mutation gate.
- [x] Bundle `grill-with-docs` skill.

## Milestone 2 — Strong Workflow Launching

- [x] Fresh-session launch supports ask/always/never modes.
- [x] `/bmad run <code>` supports workflow args.
- [x] `/bmad run next` launches the recommendation engine target.
- [x] `/bmad autopilot` switches to autonomous mode and launches next required workflow.
- [x] Runtime updates `currentWorkflow` from launched skill.
- [x] Runtime records workflow launch history.
- [ ] Runtime records workflow completion evidence.
- [ ] Better status rendering in Pi TUI.

## Milestone 3 — Grill Gate Integration

- [x] `/bmad grill` command.
- [ ] Automatic grill recommendations before PRD finalization.
- [ ] CONTEXT.md and ADR detection surfaced in `/bmad status`.
- [ ] Planning artifacts include links to grill outputs.

## Milestone 4 — Subagent Runtime

- [ ] Embed or depend on Pi subagent pattern.
- [ ] Register `bmad_delegate` tool.
- [ ] Add reviewer subagents: Blind Hunter, Edge Case Hunter, Acceptance Auditor.
- [ ] Add architecture critic and story compiler subagents.
- [ ] Use parallel review for `bmad-code-review` equivalent flows.

## Milestone 5 — Autonomous Phase 3/4 Runner

- [x] `/bmad autopilot` command.
- [x] Sprint status parser/validator.
- [x] Basic sprint status transition gate.
- [x] Sprint summary surfaced in `/bmad status`.
- [ ] Cross-check story file status against sprint status.
- [ ] Validate review findings before allowing `done`.
- [ ] Create-story → dev-story → review loop.
- [ ] Offset-1 pipeline support with WIP gates.
- [ ] Done gate validator.
- [ ] Failure recovery and resumability.

## Milestone 6 — Package Hardening

- [x] Tests for CSV parser, scanner, recommendation engine, gates.
- [ ] npm publishing metadata.
- [ ] Example fixture project.
- [ ] README install demos.
- [ ] Security review.
