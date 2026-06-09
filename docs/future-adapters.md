# Future Adapter Boundary

This document records feasibility boundaries for future host adapters. It does not add v0.2 support for external hosts.

Pi-native remains the only P0 Runtime/Agent Adapter in v0.2.

## Required Boundary Fields

Every future adapter feasibility entry must define:

- inputs;
- outputs;
- artifact paths;
- gate events;
- minimum command capabilities;
- responsibilities;
- limitations;
- prototype/smoke criteria.

## Future Targets

| Target | v0.2 support | Minimum command capabilities | Main limitations |
|---|---|---|---|
| Codex | future feasibility only | start/resume project, show status/next gate, run/request next workflow, write handoff | thread/worktree coordination and approval semantics must be proven separately |
| OpenCode | future feasibility only | start/resume project, show status/next gate, run/request next workflow, write handoff | host command/session APIs and artifact persistence behavior are unverified |
| Claude Code | future feasibility only | start/resume project, show status/next gate, run/request next workflow, write handoff | slash-command/hook semantics and review delegation parity are unverified |

## Shared Inputs

- BMAD project identity.
- Runtime state summary.
- Latest handoff excerpt.
- Canonical artifact paths.
- Sprint status and next gate.

## Shared Outputs

- Updated handoff.
- Workflow or story evidence.
- Gate result.
- Changed files summary when implementation is in scope.
- Next safe action.

## Shared Artifact Paths

- `.bmad-runtime/state.json`
- `.bmad-runtime/handoffs/latest-handoff.md`
- `_bmad-output/**/planning-artifacts/**`
- `_bmad-output/**/implementation-artifacts/**`
- `_bmad-output/**/evidence/**`

## Shared Gate Events

- Project identity resolved.
- Readiness evaluated.
- Story created.
- Dev evidence recorded.
- Code review completed.
- Done gate passed or blocked.

## Responsibilities

Future adapters must preserve BMAD core semantics, read artifacts before acting, persist evidence before done, respect project/runtime/code boundaries and stop for autonomy-contract blockers.

## Limitations

External host adapters are not supported in v0.2. They must not register external adapter commands, claim host tool parity, or replace Pi-native P0 behavior.

## Prototype/Smoke Criteria

A future prototype is credible only if it can:

- load a project from state plus handoff without chat memory;
- report the next gate from artifacts;
- record evidence in project-owned artifacts;
- avoid code mutation when project identity is ambiguous;
- continue Phase 3/4 automation without a separate automation command.

The machine-readable boundary is in `extensions/bmad-runtime/future-adapters.ts`.
