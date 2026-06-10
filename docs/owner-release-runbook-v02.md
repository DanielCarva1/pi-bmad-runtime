# Owner Release Runbook v0.2

Use this runbook only after the Owner explicitly decides to publish `pi-bmad-runtime v0.2.1` to GitHub. Until then, every command in the readiness path stays local and read-only.

## Preconditions

- Work from the package repository root, not from a consumer project workspace.
- Confirm the current branch is the release branch you intend to publish.
- Confirm `docs/release-checklist-v02.md` still matches this runbook.
- Do not publish to npm unless that is separately approved.
- Do not create GitHub release notes unless that is separately approved.

## 1. Local Readiness

Run these checks before touching Git staging:

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
npm run smoke:commands
```

Expected result:

- `audit:objective` reports no missing local evidence and keeps remote completion Owner-gated.
- `audit:context` reports agent-facing prompts and compact contracts within budget.
- `audit:release` reports `externalWrites: false`.
- `status:scope` groups every dirty path for review.
- `status:publication` reports tag/publication state without creating a commit, tag, push or release.
- `status:owner-release` summarizes whether the remaining gate is only the Owner publication decision.
- tests, pack dry-run, Pi install smoke and command discovery smoke pass.

## 2. Review Scope

Use `npm run status:scope` as the staging map. Review every path before staging it:

```bash
git status --short
git diff --stat
git diff -- <path>
```

Stage only reviewed package-release files:

```bash
git add <reviewed files>
```

Do not use `git add .`. Keep consumer workspaces, local `.pi/`, local `.bmad-runtime/`, host-project `_bmad-output/`, logs, env files and unrelated dirty paths out of the release commit unless the Owner intentionally includes them.

## 3. Commit, Tag, Push

After local readiness passes and reviewed files are staged:

```bash
git commit -m "release: pi-bmad-runtime v0.2.1"
git tag v0.2.1
git push origin main
git push origin v0.2.1
```

If the release branch is not `main`, replace `main` with the current release branch.

## 4. Verify Publication

After pushing, verify the remote tag before telling anyone to install from GitHub:

```bash
npm run status:publication -- --check-remote
npm run status:owner-release -- --check-remote
git ls-remote --tags origin refs/tags/v0.2.1
npm run smoke:git-install
npm run smoke:commands -- --git
npm run audit:objective:remote
```

The Git install command is valid only after the remote tag exists:

```bash
pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.1
```

The release is not fully objective-proven until `npm run smoke:git-install`, `npm run smoke:commands -- --git`, and `npm run audit:objective:remote` pass against the pushed tag.

## Stop Conditions

- Stop if any local readiness command fails.
- Stop if `status:scope` shows unclassified or unrelated paths.
- Stop if `status:publication` reports an unexpected existing tag.
- Stop if the remote tag verification does not show `refs/tags/v0.2.1`.
- Stop if `npm run smoke:git-install` cannot install the pushed Git tag in a temporary project.
- Stop if `npm run smoke:commands -- --git` cannot discover `/bmad-start` exactly without a duplicate suffix.
- Stop if `npm run audit:objective:remote` does not report `completionProven: true`.
