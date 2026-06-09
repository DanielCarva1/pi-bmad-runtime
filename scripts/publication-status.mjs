#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(process.argv.find((arg) => arg.startsWith("--package-root="))?.slice("--package-root=".length) ?? path.join(scriptDir, ".."));
const tag = process.argv.find((arg) => arg.startsWith("--tag="))?.slice("--tag=".length) ?? "v0.2.0";
const remote = process.argv.find((arg) => arg.startsWith("--remote="))?.slice("--remote=".length) ?? "origin";
const checkRemote = process.argv.includes("--check-remote");

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const output = {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ok: (result.status ?? 1) === 0,
  };
  if (!output.ok && !options.allowFailure) {
    throw new Error([`git ${args.join(" ")} failed`, output.stdout.trim(), output.stderr.trim()].filter(Boolean).join("\n"));
  }
  return output;
}

function lines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

try {
  const inside = git(["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
  const branch = git(["branch", "--show-current"], { allowFailure: true }).stdout.trim() || "(detached)";
  const head = git(["rev-parse", "--short=12", "HEAD"]).stdout.trim();
  const statusLines = lines(git(["status", "--porcelain"]).stdout);
  const localTag = git(["tag", "--list", tag]).stdout.trim();
  const remoteUrl = git(["remote", "get-url", remote], { allowFailure: true }).stdout.trim();
  const remoteTag = checkRemote && remoteUrl
    ? git(["ls-remote", "--tags", remote, `refs/tags/${tag}`], { allowFailure: true })
    : undefined;
  const remoteTagExists = remoteTag ? remoteTag.ok && remoteTag.stdout.includes(`refs/tags/${tag}`) : false;
  const localTagExists = localTag === tag;
  const worktreeClean = statusLines.length === 0;

  const nextActions = [];
  if (!worktreeClean) nextActions.push("Review dirty worktree; stage and commit only intended release files after Owner approval.");
  if (!localTagExists) nextActions.push(`After Owner approval and commit, create local tag: git tag ${tag}.`);
  if (!checkRemote) nextActions.push(`Run npm run status:publication -- --check-remote to verify remote tag ${tag}.`);
  if (checkRemote && !remoteTagExists) nextActions.push(`Push and verify remote tag after Owner approval: git push ${remote} ${tag}.`);
  if (worktreeClean && localTagExists && (!checkRemote || remoteTagExists)) nextActions.push("Publication status has no remaining local/tag gap for the selected checks.");

  const releaseComplete = worktreeClean && localTagExists && (!checkRemote || remoteTagExists);
  console.log(JSON.stringify({
    ok: true,
    packageRoot,
    tag,
    remote,
    insideWorkTree: inside,
    branch,
    head,
    worktreeClean,
    dirtyPathCount: statusLines.length,
    dirtyPaths: statusLines.slice(0, 50),
    localTagExists,
    remoteUrl: remoteUrl || null,
    remoteChecked: checkRemote,
    remoteTagExists: checkRemote ? remoteTagExists : null,
    releaseComplete,
    nextActions,
    externalWrites: false,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    packageRoot,
    tag,
    remote,
    error: error instanceof Error ? error.message : String(error),
    externalWrites: false,
  }, null, 2));
  process.exitCode = 1;
}
