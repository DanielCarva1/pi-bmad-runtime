# Moved Workspace Rebind

Use this when a known BMAD project was moved to a new folder.

```text
/bmad-start
```

Expected flow:

1. The runtime compares registry metadata with local `.bmad-runtime`, artifact root and git evidence.
2. If the current folder strongly matches a known project but the old root is stale, the agent asks for confirmed rebind.
3. Only after confirmation does the runtime update registry roots/path aliases.
4. The project resumes from runtime state plus latest handoff.

Blocked example:

```text
Cause: registry points to an obsolete path and the current folder is only a possible match.
Write occurred: false.
Recovery: confirm rebind in the conversational picker or open Pi in the registered workspace.
```
