# Pi Install Smoke

Use this smoke before release or before handing the package to another machine.

```bash
npm run smoke:pi-install
```

When run through npm, the smoke may use the local development `pi` binary from `node_modules/.bin`. To validate the user's global Pi CLI on `PATH`, run:

```bash
node scripts/pi-install-smoke.mjs
```

The smoke:

1. creates a temporary project workspace;
2. runs `pi install <package-root> -l`;
3. verifies project-local `.pi/settings.json`;
4. runs `pi list`;
5. verifies `pi-bmad-runtime` is listed under project packages.

It does not publish, push, tag, deploy, or modify real project workspaces.

## Command Discovery Smoke

Run this after install smoke and before handing the package to another machine:

```bash
npm run smoke:commands
```

This starts Pi in RPC offline mode inside a temporary project and verifies the canonical commands are discoverable exactly as:

```text
/bmad
/bmad-start
/bmad-help
```

It fails with `bmad-command-discovery-failed` if Pi reports suffixed duplicate names such as `/bmad-start:1`. That usually means the runtime is installed twice, for example once in user settings and once in project settings. Keep only one `pi-bmad-runtime` entry in `pi list`, then restart Pi.

Use `-- --keep` to keep the temporary workspace for inspection:

```bash
npm run smoke:pi-install -- --keep
```

## Git Install Smoke After Release

Run only after Owner approval, commit, tag push, and remote tag verification:

```bash
npm run smoke:git-install
```

This proves the public install command in a temporary project:

```bash
pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.2
pi list
```

Before the remote `v0.2.2` tag exists, the smoke exits with `reason: remote-tag-missing` and does not attempt installation.
