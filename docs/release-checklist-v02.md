# v0.2 Release Checklist

Use this only after Owner release approval. The detailed handoff procedure is `docs/owner-release-runbook-v02.md`.

## Local Readiness

```bash
npm run audit:objective
npm run audit:context
npm run audit:release
npm run status:scope
npm run status:publication
npm run status:owner-release
npm test
npm run pack:dry-run
npm run smoke:pi-install
node scripts/pi-install-smoke.mjs
```

Expected:

- tests pass;
- objective audit has no missing local evidence;
- context audit keeps agent-facing prompts and compact contracts within budget;
- release audit passes without external writes;
- release scope groups dirty paths so the Owner can stage only reviewed files;
- publication status reports the current dirty worktree/tag state without external writes;
- owner release status summarizes the local Owner gate without staging, commit, tag, push or publish;
- `npm pack --dry-run` reports `pi-bmad-runtime@0.2.0`;
- local Pi install smoke passes with project-local `.pi/settings.json`;
- no external publish, push, tag, or deploy has happened yet.

## GitHub Publication

Only after Owner approval:

```bash
git status
git add <reviewed files>
git commit -m "release: pi-bmad-runtime v0.2.0"
git tag v0.2.0
git push origin <branch>
git push origin v0.2.0
```

Then verify the public install pin:

```bash
npm run status:publication -- --check-remote
git ls-remote --tags origin refs/tags/v0.2.0
npm run smoke:git-install
npm run audit:objective:remote
```

The README Git install command is valid only after the tag exists remotely:

```bash
pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.0
```

Run `npm run smoke:git-install` and `npm run audit:objective:remote` only after the remote tag exists. If the smoke reports `remote-tag-missing`, the public Git install is not proven yet.

## Boundaries

- Do not publish to npm unless that is separately approved.
- Do not create GitHub release notes unless separately approved.
- Do not push unrelated dirty worktree changes.
- Use `npm run status:scope` before staging; it is read-only and does not run `git add`.
- Do not tag before local readiness checks pass.
- `npm run status:publication` and `npm run status:publication -- --check-remote` are read-only checks; they do not commit, tag, or push.
- Do not claim Phase 4 release approval from readiness artifacts alone.
- Do not skip `docs/owner-release-runbook-v02.md` when publishing the GitHub tag.
