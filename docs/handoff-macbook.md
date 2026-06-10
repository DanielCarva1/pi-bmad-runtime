# MacBook handoff: install Pi+BMad Runtime

Repository: https://github.com/DanielCarva1/pi-bmad-runtime

## Prerequisites

1. Install Pi on the MacBook.
2. Make sure GitHub access works for this repository. If the repo is private, the owner must add the teammate as a collaborator/member first.
3. Use Node.js 22 or newer if Pi/package installation needs a local Node runtime. Do not use the maintainer local path examples; install from the GitHub URL below.

## Install in a project

Run these commands from the repository/project where the teammate wants to use BMAD:

```bash
cd <project-repo>
pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.2
pi
```

If the machine uses SSH GitHub authentication instead of HTTPS:

```bash
cd <project-repo>
pi install -l git:git@github.com:DanielCarva1/pi-bmad-runtime@v0.2.2
pi
```

## Start BMAD inside Pi

Inside the Pi session:

```text
/bmad-start
/bmad-help
```

If `/bmad-start` is treated as chat text instead of a command, leave Pi and run `pi list` from the same project folder. Remove duplicate `pi-bmad-runtime` entries so the runtime is loaded only once, then restart Pi.

## Daily commands

```text
/bmad-start
/bmad status
/bmad next
/bmad run next
/bmad-help
```

`/bmad-start` opens the conversational picker. From there, the agent asks whether to continue an existing BMAD project from runtime state/latest handoff or create a new dedicated project workspace. Use `/bmad init` only if `/bmad-start` reports missing local runtime state or an unsafe project resolution that needs explicit repair.
