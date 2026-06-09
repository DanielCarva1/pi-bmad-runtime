# Local-Only Workspace

Use this when the user wants a new BMAD project that is not tied to GitHub or a remote.

```text
/bmad-start
```

Expected flow:

1. The agent asks whether to continue an existing project or create a new one.
2. The user chooses a new project and gives the project name.
3. The runtime creates a dedicated workspace such as `~/bmad-projects/project-name--shortid`.
4. The runtime writes project-local `.pi/settings.json` when the package source can be propagated.

Local git is optional. If the user chooses local versioning, the runtime may initialize git locally and create an initial BMAD commit:

```text
git init: local-only.
Initial commit message: bmad: initialize <project-name>.
GitHub/remote/push: not created automatically.
```

Blocked example:

```text
Cause: preferred workspace root is unavailable or unsafe.
Write occurred: false.
Recovery: choose a safe dedicated root, then retry the new-project choice through /bmad-start.
```
