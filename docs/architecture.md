# Architecture — BMAD Runtime for Pi

## 1. Context

Pi supports packages containing extensions, skills, prompts, and themes. Extensions can register commands, intercept input/tool calls, inject hidden context before agent turns, manage active tools, create new sessions, and persist state through session entries.

BMAD Method already provides skills and artifact conventions. The runtime should wrap those conventions rather than fork them.

## 2. High-Level Design

```text
User
  ↓ /bmad
Pi Extension: bmad-runtime
  ├─ StateStore (.bmad-runtime/state.json)
  ├─ CatalogScanner (_bmad/_config/bmad-help.csv)
  ├─ ArtifactScanner (_bmad-output/**)
  ├─ RecommendationEngine
  ├─ LockContextInjector (before_agent_start)
  ├─ PlanningMutationGate (tool_call)
  └─ WorkflowLauncher (fresh session preferred)
       ↓
Pi Skills
  ├─ bmad-runtime-for-pi
  ├─ grill-with-docs
  └─ existing bmad-* skills in the host project
```

## 3. Package Layout

```text
pi-bmad-runtime/
├── package.json
├── extensions/bmad-runtime/
│   ├── index.ts
│   ├── catalog.ts
│   ├── gates.ts
│   ├── paths.ts
│   ├── scanner.ts
│   ├── state.ts
│   └── ui.ts
├── skills/
│   ├── bmad-runtime-for-pi/SKILL.md
│   └── grill-with-docs/
├── prompts/
└── docs/
```

## 4. Runtime State

State lives in the host project, not in the package:

```text
<host-project>/.bmad-runtime/state.json
```

Shape:

```json
{
  "version": 1,
  "active": true,
  "mode": "interview",
  "track": "undecided",
  "phase": "1-analysis",
  "currentWorkflow": null,
  "autonomy": {
    "phase3And4Yolo": true,
    "askUserOnlyFor": ["credentials", "paid external services", "irreversible destructive actions", "contradictory approved artifacts"]
  },
  "createdAt": "2026-05-18T...Z",
  "updatedAt": "2026-05-18T...Z",
  "parkingLot": []
}
```

The extension also writes `pi.appendEntry("bmad-runtime-state", state)` for session-local auditability, but file state is canonical across sessions.

## 5. Catalog and Completion Detection

The scanner reads:

```text
_bmad/_config/bmad-help.csv
```

Important fields:

- `skill`
- `display-name`
- `menu-code`
- `description`
- `phase`
- `after`
- `before`
- `required`
- `output-location`
- `outputs`

Completion is initially heuristic:

1. resolve output locations such as `planning_artifacts` and `implementation_artifacts`;
2. recursively list files;
3. match expected output terms against file paths and selected content snippets;
4. mark rows as likely complete when evidence exists.

Future versions should add per-workflow validators.

## 6. Recommendation Engine

Algorithm:

1. group rows by phase order;
2. identify required incomplete rows;
3. filter by `after` dependencies where possible;
4. recommend the earliest unblocked required row;
5. list optional same-phase rows separately.

This is intentionally conservative. If uncertain, the runtime should recommend `bmad-help` or a human-visible readiness check.

## 7. Lock Mode

When state is active:

- `before_agent_start` injects hidden BMAD runtime context;
- `input` routes explicit exit phrases to `/bmad exit` semantics;
- non-`/bmad` user text is treated as steering inside the runtime, not permission to ignore the runtime;
- tool gates prevent planning phases from mutating source code.

## 8. Human vs Autonomous Modes

### Interview Mode

Used for Phase 1 and 2.

- Ask questions aggressively.
- Use `grill-with-docs` when terminology or domain boundaries are unclear.
- Do not proceed past weak assumptions silently.
- Human approval is expected for scope and product intent.

### Autonomous Mode

Used for Phase 3 and 4.

- Execute without routine human participation.
- Follow BMAD workflows exactly.
- Ask user only for autonomy-contract blockers.
- Use subagents for review, research, architecture critique, and code review where available.

## 9. Fresh Sessions

BMAD recommends a fresh chat for each workflow. `/bmad run <code>` should prefer `ctx.newSession()` and seed the replacement session with:

- current runtime state;
- target workflow;
- artifact paths;
- command to invoke the BMAD skill.

If session replacement is unavailable, fallback is same-session launch with a warning.

## 10. Subagent Roadmap

The Pi examples include a subagent extension that spawns isolated `pi --mode json -p --no-session` processes. BMAD Runtime should either depend on or embed a variant of that pattern.

Initial subagents:

- Domain Grill Reviewer
- Architecture Critic
- Story Context Compiler
- Developer Worker
- Blind Hunter
- Edge Case Hunter
- Acceptance Auditor

## 11. Security and Safety

Pi packages run with full local permissions. This package must be explicit about trust boundaries:

- project-local BMAD skills are repo-controlled;
- autonomous mode can modify code;
- external MCP/publishing actions need explicit autonomy-contract permission;
- destructive commands remain blocked unless explicitly allowed.
