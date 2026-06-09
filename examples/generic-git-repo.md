# Generic Git Repo

Use this when the current folder is a normal git repo but has no BMAD workspace binding yet.

```text
/bmad-start
```

Expected flow:

1. The runtime detects a generic git repository.
2. The agent asks whether to use the current repo as the BMAD Project Workspace or create a dedicated BMAD workspace elsewhere.
3. The user gives explicit intent before any project binding or artifact creation happens.

Blocked example:

```text
Cause: generic git repository detected without .bmad-runtime, artifact root or registry binding.
Write occurred: false.
Recovery: choose "use this repo as the BMAD workspace" or "create a dedicated BMAD workspace" from the conversational picker.
```

GitHub, remote creation, push, publication and deploy are not automatic. They require explicit Owner approval.
