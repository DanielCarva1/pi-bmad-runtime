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

- [ ] Fresh-session launch hardened across interactive/print/RPC modes.
- [ ] `/bmad run <code>` supports workflow args.
- [ ] Runtime updates `currentWorkflow` from launched skill.
- [ ] Runtime records workflow completion evidence.
- [ ] Better status rendering in Pi TUI.

## Milestone 3 — Grill Gate Integration

- [ ] `/bmad grill` command.
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

- [ ] `/bmad autopilot` command.
- [ ] Sprint status parser/validator.
- [ ] Create-story → dev-story → review loop.
- [ ] Offset-1 pipeline support with WIP gates.
- [ ] Done gate validator.
- [ ] Failure recovery and resumability.

## Milestone 6 — Package Hardening

- [ ] Tests for CSV parser, scanner, recommendation engine, gates.
- [ ] npm publishing metadata.
- [ ] Example fixture project.
- [ ] README install demos.
- [ ] Security review.
