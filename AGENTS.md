# Project Instructions — BMAD Runtime for Pi

- This repo is separate from `zico-os`; do not modify `zico-os` while working here unless explicitly asked.
- The product is a Pi package that wraps BMAD Method; do not fork or replace BMAD workflows unless a story explicitly requires it.
- Keep Phase 1/2 human-in-loop and Phase 3/4 autonomous in the runtime design.
- Use `docs/prd.md`, `docs/architecture.md`, `docs/epics.md`, and `docs/autonomy-contract.md` as source-of-truth planning artifacts.
- Run `npm run typecheck` after TypeScript extension changes.
- Use `npm pack --dry-run` before package-shape changes.
