# Ambiguous Project Picker

Use this when more than one registered BMAD project could match the current folder, name, alias or git evidence.

```text
/bmad-start
```

Expected flow:

1. The runtime refuses to choose silently.
2. The agent shows a name-first project picker sorted by recency or match strength.
3. The user can ask for details before choosing.
4. After a unique project is chosen, the runtime resumes from state plus latest handoff.

Details should include only bounded metadata:

- Stable ID.
- Aliases.
- Artifact root.
- Runtime state path.
- Last workflow/readiness.
- Git evidence fingerprint, branch and commit, not raw remote secrets.

Blocked example:

```text
Cause: multiple registry projects match the current cwd or selector.
Write occurred: false.
Recovery: choose a specific project by name or Stable ID from the picker.
```
