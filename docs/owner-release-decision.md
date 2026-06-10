# Owner Release Decision

Purpose: give a non-Git-expert Owner one read-only command that summarizes whether `pi-bmad-runtime v0.2.2` is locally ready for a release decision.

Run from the package repository:

```bash
npm run status:owner-release
```

To include remote tag verification:

```bash
npm run status:owner-release -- --check-remote
```

The command aggregates:

- objective readiness;
- context budget;
- release audit;
- release scope;
- publication status.

It never stages, commits, tags, pushes, publishes to npm, or creates a GitHub release.

Read the JSON fields:

- `readyForOwnerDecision: true` means local audit evidence is present and the remaining gate is the Owner's publication decision.
- `ownerGated: true` means remote release proof is intentionally not complete yet.
- `releaseComplete: true` means the checked publication state has no remaining local/tag gap.
- `blockedActionsWithoutOwnerApproval` lists actions the runtime must not perform automatically.

If the Owner approves publication, follow `docs/owner-release-runbook-v02.md`.
After the remote tag exists, run `npm run smoke:git-install`, `npm run smoke:commands -- --git`, and `npm run audit:objective:remote` to prove the public Git install command, canonical slash-command discovery, and final objective completion.
