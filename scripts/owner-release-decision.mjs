#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(process.argv.find((arg) => arg.startsWith("--package-root="))?.slice("--package-root=".length) ?? path.join(scriptDir, ".."));
const checkRemote = process.argv.includes("--check-remote");

function parseJson(text) {
  return JSON.parse(text.replace(/^\uFEFF/, "").trim());
}

function runJson(label, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: packageRoot,
    encoding: "utf8",
  });
  let parsed;
  let parseError;
  try {
    parsed = parseJson(result.stdout || result.stderr || "{}");
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  const ok = (result.status ?? 1) === 0 && parsed?.ok !== false && !parseError;
  return {
    label,
    ok,
    status: result.status ?? 1,
    failedCount: Array.isArray(parsed?.failed) ? parsed.failed.length : undefined,
    missingCount: Array.isArray(parsed?.missing) ? parsed.missing.length : undefined,
    ownerGatedCount: Array.isArray(parsed?.ownerGated) ? parsed.ownerGated.length : undefined,
    releaseComplete: typeof parsed?.releaseComplete === "boolean" ? parsed.releaseComplete : undefined,
    dirtyPathCount: typeof parsed?.dirtyPathCount === "number" ? parsed.dirtyPathCount : parsed?.rawDirtyPathCount,
    unclassifiedCount: Array.isArray(parsed?.groups) ? (parsed.groups.find((group) => group.category === "unclassified")?.count ?? 0) : undefined,
    warnings: Array.isArray(parsed?.warnings) ? parsed.warnings : undefined,
    error: parseError || (ok ? undefined : parsed?.error || result.stderr.trim() || result.stdout.trim()),
    parsed,
  };
}

try {
  const checks = [
    runJson("objective-readiness", ["scripts/objective-readiness-audit.mjs"]),
    runJson("context-budget", ["scripts/context-budget-audit.mjs"]),
    runJson("release-audit", ["scripts/release-audit.mjs"]),
    runJson("release-scope", ["scripts/release-scope.mjs"]),
    runJson("publication-status", ["scripts/publication-status.mjs", ...(checkRemote ? ["--check-remote"] : [])]),
  ];

  const objective = checks.find((check) => check.label === "objective-readiness");
  const scope = checks.find((check) => check.label === "release-scope");
  const publication = checks.find((check) => check.label === "publication-status");
  const ownerGated = (objective?.ownerGatedCount ?? 0) > 0 && objective?.parsed?.completionProven === false;
  const missingLocalEvidence = (objective?.missingCount ?? 0) > 0;
  const unclassifiedPaths = scope?.unclassifiedCount ?? 0;
  const releaseComplete = publication?.releaseComplete === true;
  const checksOk = checks.every((check) => check.ok);
  const readyForOwnerDecision = checksOk && !missingLocalEvidence && unclassifiedPaths === 0 && ownerGated && !releaseComplete;

  const nextActions = releaseComplete
    ? ["Remote release/install proof is complete for the checked publication state."]
    : readyForOwnerDecision
      ? [
          "Owner may review docs/owner-release-runbook-v02.md and decide whether to publish v0.2.0.",
          "If approved, stage only reviewed files; do not use git add .",
          "After commit, create and push tag v0.2.0, then rerun npm run status:owner-release -- --check-remote, npm run smoke:git-install, and npm run audit:objective:remote.",
        ]
      : [
          "Do not publish yet.",
          "Resolve failed checks, missing local evidence, unclassified paths, or unexpected publication state before Owner approval.",
        ];

  const failed = checks
    .filter((check) => !check.ok)
    .map((check) => ({ label: check.label, status: check.status, error: check.error }));

  console.log(JSON.stringify({
    ok: checksOk,
    packageRoot,
    readyForOwnerDecision,
    ownerGated,
    releaseComplete,
    checkRemote,
    checks: checks.map((check) => ({
      label: check.label,
      ok: check.ok,
      failedCount: check.failedCount,
      missingCount: check.missingCount,
      ownerGatedCount: check.ownerGatedCount,
      dirtyPathCount: check.dirtyPathCount,
      unclassifiedCount: check.unclassifiedCount,
      releaseComplete: check.releaseComplete,
      warnings: check.warnings,
    })),
    failed,
    nextActions,
    blockedActionsWithoutOwnerApproval: ["git add", "git commit", "git tag", "git push", "npm publish", "GitHub release"],
    externalWrites: false,
  }, null, 2));
  if (!checksOk) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    packageRoot,
    error: error instanceof Error ? error.message : String(error),
    externalWrites: false,
  }, null, 2));
  process.exitCode = 1;
}
