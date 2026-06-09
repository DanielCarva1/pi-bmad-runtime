# Context Budget

Purpose: keep BMAD Runtime prompts small enough that `/bmad-start` can resume work without pulling long method docs or whole project history into the agent window.

## Policy

Full BMAD docs are fallback references, not bootstrap input.

Default source order:

1. Runtime state and project identity.
2. Latest handoff excerpt.
3. Sprint status entry and active story sections.
4. Compact contracts in `docs/agent-operating-contract.md` and `docs/agent-artifact-contract.md`.
5. Smallest canonical artifact that resolves the next blocker.

## Budgets

| Surface | Budget |
| --- | --- |
| `docs/agent-operating-contract.md` | 6000 bytes, 120 lines |
| `docs/agent-artifact-contract.md` | 5500 bytes, 170 lines |
| `docs/context-budget.md` | 4500 bytes, 100 lines |
| `skills/bmad-runtime-for-pi/SKILL.md` | 7000 bytes, 150 lines |
| each packaged prompt file | 1500 bytes, 60 lines |
| compact bootstrap corpus | 25000 bytes total |
| latest handoff excerpt in resume bootstrap | 6144 bytes |

Generated prompt tests also keep start/router, continuation bootstrap, and Phase 4 execution-plan prompts bounded.

## Audit

Run:

```bash
npm run audit:context
```

The audit is read-only. It fails if compact contracts grow past budget, packaged prompt files become large, or shipped runtime guidance points agents at long BMAD source docs as prompt input.
