#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(process.argv.find((arg) => arg.startsWith("--package-root="))?.slice("--package-root=".length) ?? path.join(scriptDir, ".."));
const keepTemp = process.argv.includes("--keep");

function normalizeForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PI_OFFLINE: "1" },
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

function settingsPackageMatches(tempRoot, value) {
  const candidate = path.isAbsolute(value) ? value : path.resolve(tempRoot, value);
  return normalizeForCompare(candidate) === normalizeForCompare(packageRoot);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-install-smoke-"));

try {
  const versionResult = run("pi", ["--version"], tempRoot);
  const piVersion = (versionResult.stdout || versionResult.stderr).trim();
  run("pi", ["install", packageRoot, "-l"], tempRoot);

  const settingsPath = path.join(tempRoot, ".pi", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const matchingPackage = packages.find((entry) => typeof entry === "string" && settingsPackageMatches(tempRoot, entry));
  if (!matchingPackage) {
    throw new Error(`Project-local settings did not include package root: ${packageRoot}`);
  }

  const list = run("pi", ["list"], tempRoot).stdout;
  if (!list.includes("Project packages:") || !list.includes(packageRoot)) {
    throw new Error("pi list did not report the runtime package as a project package.");
  }

  console.log(JSON.stringify({
    ok: true,
    piVersion,
    packageRoot,
    tempRoot: keepTemp ? tempRoot : "<removed>",
    settingsPath: keepTemp ? settingsPath : ".pi/settings.json",
    matchingPackage,
    projectPackageListed: true,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    packageRoot,
    tempRoot,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (!keepTemp) fs.rmSync(tempRoot, { recursive: true, force: true });
}
