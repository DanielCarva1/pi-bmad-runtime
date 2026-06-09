# BMAD Core Semantics vs Runtime/Agent Adapter

This contract separates BMAD semantics from the runtime surface that executes them.

Pi remains the P0 implementation for v0.2. The contract does not implement Codex, OpenCode, Claude Code, fork/persona behavior, or any separate automation command.

## Boundary

| Layer | Owns | Does not own |
|---|---|---|
| BMAD Core Semantics | Phase model, workflow state, artifacts, gates, evidence and registry | Slash commands, host APIs, UI formatting, session mechanics or agent execution |
| Runtime/Agent Adapter | Command surface, tools, UI/prompts and agent execution | Changing BMAD phase semantics, skipping gates or treating chat memory as completion evidence |
| Out of scope for v0.2 | Future adapter feasibility and fork/persona experiments | P0 runtime behavior |

## Core Responsibilities

- Phase model: BMAD phase sequence, phase names and legal transitions.
- Workflow state: current workflow, step, story and completion state.
- Artifacts: canonical PRD, architecture, epics, stories, sprint status, evidence and handoffs.
- Gates: readiness, completion, safety, retry and done-gate rules.
- Evidence: required records for workflow, story, review and state transitions.
- Registry: metadata-only project identity, aliases, roots, state path and schema version.

Core semantics must remain host-independent. They should be explainable without referring to Pi command APIs, `.pi` settings, session mechanics or prompt transport.

## Runtime/Agent Adapter Responsibilities

- Command surface: maps `/bmad-start`, `/bmad start`, `/bmad status`, `/bmad resume` and related commands to runtime actions.
- Tool boundary: integrates host tools, tool-call gates and local execution plumbing.
- UI/prompt boundary: formats pickers, status messages, hidden context and resume bootstrap prompts.
- Agent execution: runs or asks the host agent to run BMAD workflows, reviews and delegation.

The adapter may be Pi-specific. That is expected for P0.

## Automation Rule

Phase 3/4 automation is normal runtime behavior behind `/bmad-start`, `/bmad start`, project resume and workflow runner policy. Separate automation commands are not part of the product.

## Verification

The TypeScript contract in `extensions/bmad-runtime/adapter-contract.ts` lists required core and adapter responsibilities. `tests/adapter-contract.test.ts` verifies that:

- all required core responsibilities are present;
- all required adapter responsibilities are present;
- core semantics do not mention Pi APIs or host command/session mechanics;
- external adapters and separate automation commands classify as out of scope for v0.2.

Future adapter feasibility boundaries are documented in `docs/future-adapters.md` and represented in `extensions/bmad-runtime/future-adapters.ts`.
