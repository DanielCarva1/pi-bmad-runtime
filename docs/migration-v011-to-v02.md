# v0.1.1 to v0.2 Registry Migration

`pi-bmad-runtime` v0.2 treats migration as metadata reconciliation. It does not create a separate automation command and it does not move, delete, or rewrite canonical BMAD artifacts.

## What Migrates

- Existing `.bmad-runtime/state.json`
- Existing `.bmad-runtime/project-identity.json`
- Existing `_bmad-output` artifact root
- Registry metadata in Runtime Home, using the current registry `schemaVersion`

The registry schema constant is `1`. The `v0.2` label is the product/runtime version, not a registry schema number.

## Migration Path

1. Snapshot canonical artifacts under `_bmad-output` with relative path, byte size, and SHA-256.
2. Ensure Runtime Home registry exists or safely apply the current `schemaVersion` to a legacy registry that only lacks `schemaVersion`.
3. Reconcile workspace metadata into the registry using stable `projectId`, display name, known roots, artifact root, runtime state path, and path aliases.
4. Snapshot canonical artifacts again.
5. Compare before/after artifact snapshots.
6. If a write fails, preserve the last valid registry and return recovery evidence for idempotent retry.

## Safety Rules

- Missing registry: create metadata-only registry with `schemaVersion: 1`.
- Registry missing only `schemaVersion`: add `schemaVersion: 1` after validating the rest of the metadata shape.
- Unsupported schema, invalid JSON, unsupported fields, duplicate project IDs, or canonical content fields: block and preserve the original registry.
- Simulated or real write failure: keep the previous valid registry in place and report recovery action.
- Artifact checksum drift: block completion and require inspection before retry.

## Programmatic Surface

Use `buildV011ReconcileMigrationPlan(cwd, options)` for read-only readiness and artifact snapshot planning.

Use `migrateV011WorkspaceToV02Registry(cwd, options)` to run schema migration plus workspace reconcile.

Both functions are package-internal runtime helpers. They are intended for `/bmad-start` resolution/resume policy and release smoke tests, not for a separate user-facing migration command.

