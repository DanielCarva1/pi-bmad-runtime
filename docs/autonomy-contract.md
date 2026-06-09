# Autonomy Contract — BMAD Runtime for Pi

The runtime separates product ambiguity from technical execution.

## Default Policy

| Phase | User Involvement | Agent Autonomy |
| --- | --- | --- |
| Phase 1 — Analysis | High | Facilitate, challenge, document |
| Phase 2 — Planning | High | Interview, grill, validate, document |
| Phase 3 — Solutioning | Low | Create architecture, epics, readiness checks |
| Phase 4 — Implementation | Low | Create stories, implement, review, test, iterate |
| Phase 5 — Ready for use | On demand | Stop the story loop; support use, monitor, validate release/install, or open an explicit next version |

## Phase 1/2 Rules

The orchestrator must not optimize for speed. It should optimize for correctness of intent.

Required behaviors:

- ask one strong question at a time when ambiguity is deep;
- ask numbered batches when ambiguity is broad;
- verify unanswered questions explicitly;
- use `grill-with-docs` for domain language, glossary conflicts, and hard-to-reverse decisions;
- use adversarial review on important documents;
- refuse to bless vague product language;
- document decisions as artifacts.

## Phase 3/4 Rules

The orchestrator should not involve the user unless blocked.

Allowed without asking:

- read project files;
- write planning and implementation artifacts;
- modify source code to satisfy approved stories;
- create tests;
- run local builds, tests, linters, and validation commands;
- create local branches/worktrees if configured later;
- run BMAD code review loops;
- spawn subagents for analysis and review.

Ask the user only for:

1. credentials, secrets, or account access;
2. paid external services or API usage not already configured;
3. destructive irreversible actions;
4. legal/compliance/product positioning decisions;
5. contradictions between approved artifacts;
6. new scope that cannot fit the approved PRD/architecture;
7. dependency installation if the project does not already allow agent-managed dependencies.

## Phase 5 Rules

Phase 5 means the product is usable. The runtime must not continue Phase 4 story automation unless a new version, story, regression, incident, or support task is explicitly opened.

## Done Definition

A story is not done until:

- all story tasks are checked;
- all ACs are satisfied;
- tests/smokes pass or failures are documented as accepted blockers;
- file list and dev record are updated;
- code review has no unresolved patch/decision-needed findings;
- sprint status and story status agree.

## Escape Hatch

The user can always deactivate the runtime with:

```text
/bmad exit
```

Without an explicit exit, user steering is interpreted inside the BMAD runtime rather than as permission to bypass BMAD.
