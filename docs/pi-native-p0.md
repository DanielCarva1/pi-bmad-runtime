# Pi-native P0

Pi-native remains the active Runtime/Agent Adapter for v0.2.

## Package Surface

The package manifest must continue to expose:

- `./extensions/bmad-runtime/index.ts` as the Pi extension entrypoint;
- `./skills` as the bundled skills directory;
- `./prompts` as the bundled prompts directory.

The runtime skill `skills/bmad-runtime-for-pi/SKILL.md`, the grill skill and BMAD prompts remain package resources.

## Optional Subagents

Pi subagents are Pi-native capabilities. When a subagent provider is present, review/delegation can use it. When it is absent, runtime behavior degrades to same-session or recorded degraded evidence without requiring an external adapter.

External adapters remain future feasibility only and must not replace Pi-native P0 in v0.2.

## P0 Smoke

`extensions/bmad-runtime/pi-native.ts` exposes a local smoke helper that validates:

- path normalization;
- local command execution;
- Project Workspace artifact read/write.

The smoke writes a project-owned evidence artifact at `_bmad-output/evidence/pi-native-p0-smoke.md` in a temporary workspace during tests.

## Verification

`tests/pi-native.test.ts` verifies package manifest resources, future-only external adapters and the local P0 smoke path/command/artifact checks.
