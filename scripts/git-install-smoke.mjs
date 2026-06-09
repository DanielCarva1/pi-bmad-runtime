#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(process.argv.find((arg) => arg.startsWith("--package-root="))?.slice("--package-root=".length) ?? path.join(scriptDir, ".."));
const tag = process.argv.find((arg) => arg.startsWith("--tag="))?.slice("--tag=".length) ?? "v0.2.0";
const remote = process.argv.find((arg) => arg.startsWith("--remote="))?.slice("--remote=".length) ?? "origin";
const source = process.argv.find((arg) => arg.startsWith("--source="))?.slice("--source=".length) ?? `git:github.com/DanielCarva1/pi-bmad-runtime@${tag}`;
const keepTemp = process.argv.includes("--keep");
const dryRun = process.argv.includes("--dry-run");
const skipRemoteCheck = process.argv.includes("--skip-remote-check");

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

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} failed with exit ${result.status}`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ].filter(Boolean).join("\n"));
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function remoteTagExists() {
  if (skipRemoteCheck) return true;
  const remoteUrl = git(["remote", "get-url", remote], { allowFailure: true }).stdout.trim();
  if (!remoteUrl) return false;
  const result = git(["ls-remote", "--tags", remote, `refs/tags/${tag}`], { allowFailure: true });
  return result.ok && result.stdout.includes(`refs/tags/${tag}`);
}

let tempRoot;

try {
  const tagExists = remoteTagExists();
  if (!tagExists) {
    console.log(JSON.stringify({
      ok: false,
      reason: "remote-tag-missing",
      packageRoot,
      source,
      tag,
      remote,
      installAttempted: false,
      nextAction: `After Owner approval, commit/tag/push ${tag}, then rerun npm run smoke:git-install.`,
      externalWrites: false,
    }, null, 2));
    process.exitCode = 1;
  } else if (dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      packageRoot,
      source,
      tag,
      remote,
      installAttempted: false,
      externalWrites: false,
    }, null, 2));
  } else {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-git-install-smoke-"));
    const versionResult = run("pi", ["--version"], tempRoot);
    const piVersion = (versionResult.stdout || versionResult.stderr).trim();
    run("pi", ["install", "-l", source], tempRoot);

    const settingsPath = path.join(tempRoot, ".pi", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    const matchingPackage = packages.find((entry) => typeof entry === "string" && entry.includes(source));
    if (!matchingPackage) {
      throw new Error(`Project-local settings did not include Git source: ${source}`);
    }

    const list = run("pi", ["list"], tempRoot).stdout;
    if (!list.includes("Project packages:") || !list.includes(source)) {
      throw new Error("pi list did not report the Git runtime package as a project package.");
    }

    console.log(JSON.stringify({
      ok: true,
      piVersion,
      packageRoot,
      source,
      tag,
      remote,
      tempRoot: keepTemp ? tempRoot : "<removed>",
      settingsPath: keepTemp ? settingsPath : ".pi/settings.json",
      matchingPackage,
      installAttempted: true,
      projectPackageListed: true,
      externalWrites: false,
    }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    packageRoot,
    source,
    tag,
    remote,
    tempRoot: tempRoot ?? null,
    error: error instanceof Error ? error.message : String(error),
    externalWrites: false,
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (tempRoot && !keepTemp) fs.rmSync(tempRoot, { recursive: true, force: true });
}
