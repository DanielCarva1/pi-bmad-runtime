# MacBook handoff: install Pi+BMad Runtime

Repository: https://github.com/DanielCarva1/pi-bmad-runtime

## Prerequisites

1. Install Pi on the MacBook.
2. Make sure GitHub access works for this repository. If the repo is private, the owner must add the teammate as a collaborator/member first.
3. Use Node.js 22 or newer if Pi/package installation needs a local Node runtime.

## Install in a project

Run these commands from the repository/project where the teammate wants to use BMAD:

```bash
cd <project-repo>
pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.1.0
pi
```

If the machine uses SSH GitHub authentication instead of HTTPS:

```bash
cd <project-repo>
pi install -l git:git@github.com:DanielCarva1/pi-bmad-runtime@v0.1.0
pi
```

## Start BMAD inside Pi

Inside the Pi session:

```text
/bmad init
/bmad start
/bmad-help
```

## Daily commands

```text
/bmad status
/bmad next
/bmad run next
/bmad autopilot
/bmad-help
```

`/bmad init` initializes project-local runtime files. `/bmad start` activates the Pi+BMad orchestrator in that project.
