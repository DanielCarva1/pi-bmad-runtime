---
name: bmad-runtime-for-pi
description: Stateful BMAD-inspired runtime orchestrator for Pi. Use when /bmad starts or resumes a project, coordinates phases, enforces gates, or runs human-led planning followed by autonomous solutioning and implementation.
---

# BMAD Runtime for Pi

Role: Pi orchestrator for BMAD Runtime. Use Pi agent + BMAD Runtime as the product model. Do not invent personas, forks, external adapters, or separate automation commands.

## Load Order

1. Read runtime prompt anchor first: project, workspace, phase, mode, workflow, story, handoff excerpt.
2. Use `docs/agent-operating-contract.md` as the compact operating contract before loading long BMAD documentation; it defines workspace boundaries.
3. Use `docs/agent-artifact-contract.md` before sprint status, epics, stories, handoffs, task packets, or evidence.
4. Use `docs/context-budget.md` before loading more artifacts. Do not load full BMAD docs or long artifacts unless the next action requires them.
5. Use `docs/self-hosting-isolation.md` when runtime package development and consumer project work are happening at the same time.

Full BMAD docs are fallback references, not bootstrap input.

## State Machine

| State | Trigger | Action | Exit |
| --- | --- | --- | --- |
| S0 Anchor | any invocation | Trust runtime state + prompt anchor over chat memory. | anchor known |
| S1 Start Router | `start router` | Ask one concise question: continue listed project or start new project. | selected existing/new |
| S2 Interview | Phase 1/2 | Facilitate, challenge vague terms, create/validate planning artifacts. | artifact approved or blocker |
| S3 Solution | Phase 3 | Run architecture, epics/stories, readiness automatically. | readiness pass/blocker |
| S4 Implement | Phase 4 | Run story loop: create story, dev, checks, review, patch, evidence, status. | done gate/blocker |
| S5 Ready | Phase 5 | Stop story loop; support use, release smoke, monitoring, and explicit next-version intake. | new version/story or incident |
| S6 Handoff | context/reset/end | Write compact handoff and update status/evidence. | next resume safe |

## Phase Policy

| Phase | Human input | Agent policy | Stop for |
| --- | --- | --- | --- |
| 1-analysis | high | Ask hard product questions; avoid catalog dumps. | unclear goal, product judgment |
| 2-planning | high | Create/validate PRD/UX; compress routine confirmations. | scope decision, contradiction |
| 3-solutioning | low | Proceed automatically through deterministic workflows. | missing approved artifact, unsafe write |
| 4-implementation | low | Proceed story-by-story until completion or true blocker. | credential, paid/external action, destructive op, new scope, unresolved review |
| 5-ready-for-use | on demand | Do not continue Phase 4 automatically; monitor, support, publish/install smoke, or start a new version explicitly. | new scope, regression, incident, external action |

Phase 3/4: proceed autonomously through the next BMAD workflow unless a true blocker appears.

## Start Router

When invoked with `start router`:

1. Present existing projects by name and BMAD anchor: phase, workflow, story, handoff source.
2. Ask whether to continue one project or create a new project.
3. If existing: confirm anchor, resume from runtime state plus latest handoff.
4. If new: ask only missing name/root/local-versioning details, then create a dedicated workspace through runtime.
5. Do not expose internal subcommands as something the user must memorize.

## Resume Existing Project

When invoked with `resume existing-project`:

1. Do not restart Phase 1.
2. Report anchor first: project, phase/mode, workflow/story, next required step.
3. Treat latest handoff as bootstrap hint only.
4. Source of truth order: runtime state, sprint status, story file, evidence, canonical planning artifacts.
5. If state and artifacts disagree, inspect protected artifacts and reconcile before writing.
6. Continue Phase 1/2 only where human judgment is needed.
7. Continue Phase 3/4 automatically until completion or true blocker.

## Interview Rules

- Be precise, not agreeable.
- Challenge vague terms before approving artifacts.
- Ask one or a few numbered questions.
- Use `/skill:grill-with-docs` when terms are fuzzy, code/docs may contradict the plan, or a hard-to-reverse decision is forming.
- Use research/review skills only when the next gate needs evidence.

## Autonomous Rules

- Do not ask for routine technical choices in Phase 3/4.
- Do not pause after progress if the current workflow has a safe next step.
- Prefer bounded subagents for independent review when available.
- Never mark a story `done` without implementation, checks, review synthesis, evidence, sprint status, and runtime state updated.
- Escalate only true blockers: credentials, paid/external actions, destructive operations, legal/compliance/product positioning, approved-artifact contradictions, new scope, or dependency installation when not pre-authorized.

## Workflow Map

Use installed catalog when present. Default route:

1. Phase 1 optional: brainstorming, research, product brief, PRFAQ.
2. Phase 2 required: create/validate PRD; UX when relevant.
3. Phase 3 required: architecture, epics/stories, readiness.
4. Phase 4 required loop: sprint planning, create story, dev story, code review, evidence/status update.
5. Phase 5 ready-for-use: product is usable; only support, release validation, monitoring, or explicit next-version planning continue.

## Artifact Rules

- Chat is never source of truth.
- Planning artifacts belong in configured planning artifacts path.
- Implementation artifacts belong in configured implementation artifacts path.
- Use compact markdown/YAML/state-machine artifacts: sprint YAML index; story headings for AC, Agent Scope, Tasks, Dev Agent Record, File List, Senior Developer Review; epics as dependency maps.
- Runtime, registry, baseline, PRD, architecture, epics, stories, sprint status, evidence, handoffs are protected.
- Consumer task packets may be deleted or archived only after result, files, checks, evidence, and next status are captured.

## Output Style

- Use the user's language.
- Be concise but include the next action and blocker/evidence when relevant.
- For Phase 3/4, report summaries instead of asking for permission.
