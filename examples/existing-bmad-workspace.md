# Existing BMAD Workspace

Use this when the current folder already has BMAD runtime state or BMAD artifacts.

```text
/bmad-start
```

Expected flow:

1. The agent detects the existing Project Workspace from `.bmad-runtime/`, `_bmad/`, `_bmad-output/` and registry metadata.
2. The agent shows the project name, phase, current workflow/story and latest handoff source.
3. The user chooses to continue that project.
4. The runtime activates the project and resumes from state plus latest handoff.

If the project is uniquely resolved, routine Phase 3/4 work continues automatically from `/bmad-start` or resume. The user should not need to run a separate automation command.

Blocked example:

```text
Cause: existing state is invalid JSON.
Write occurred: false.
Recovery: repair or restore .bmad-runtime/state.json, then run /bmad-start again.
```
