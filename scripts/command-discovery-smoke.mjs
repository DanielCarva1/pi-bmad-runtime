#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(process.argv.find((arg) => arg.startsWith("--package-root="))?.slice("--package-root=".length) ?? path.join(scriptDir, ".."));
const tag = process.argv.find((arg) => arg.startsWith("--tag="))?.slice("--tag=".length) ?? "v0.2.1";
const sourceArg = process.argv.find((arg) => arg.startsWith("--source="))?.slice("--source=".length);
const source = sourceArg ?? (process.argv.includes("--git") ? `git:github.com/DanielCarva1/pi-bmad-runtime@${tag}` : packageRoot);
const keepTemp = process.argv.includes("--keep");
const dryRun = process.argv.includes("--dry-run");
const requiredCommands = ["bmad", "bmad-start", "bmad-help"];

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

function bmadNames(commands) {
  return commands
    .filter((command) => command.name === "bmad" || command.name.startsWith("bmad-") || /^bmad(?::\d+)$/.test(command.name))
    .map((command) => ({
      name: command.name,
      source: command.source,
      sourceInfo: command.sourceInfo,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

let tempRoot;
let client;

try {
  if (dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      packageRoot,
      source,
      requiredCommands,
      externalWrites: false,
    }, null, 2));
    process.exit(0);
  }

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-command-smoke-"));
  const versionResult = run("pi", ["--version"], tempRoot);
  const piVersion = (versionResult.stdout || versionResult.stderr).trim();
  run("pi", ["install", "-l", source], tempRoot);

  const rpcClientPath = path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "rpc", "rpc-client.js");
  const cliPath = path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  if (!fs.existsSync(rpcClientPath) || !fs.existsSync(cliPath)) {
    throw new Error("Pi coding-agent dev dependency is missing. Run npm install before command discovery smoke.");
  }

  const { RpcClient } = await import(pathToFileURL(rpcClientPath).href);
  client = new RpcClient({
    cwd: tempRoot,
    cliPath,
    args: ["--offline", "--no-session"],
    env: { PI_OFFLINE: "1" },
  });
  await client.start();
  const commands = await client.getCommands();
  await client.stop();
  client = undefined;

  const names = new Set(commands.map((command) => command.name));
  const missing = requiredCommands.filter((name) => !names.has(name));
  const suffixed = commands.filter((command) => requiredCommands.some((name) => command.name.startsWith(`${name}:`)));
  if (missing.length || suffixed.length) {
    throw new Error(JSON.stringify({
      reason: "bmad-command-discovery-failed",
      missing,
      suffixed: bmadNames(suffixed),
      bmadCommands: bmadNames(commands),
    }, null, 2));
  }

  console.log(JSON.stringify({
    ok: true,
    piVersion,
    packageRoot,
    source,
    tempRoot: keepTemp ? tempRoot : "<removed>",
    requiredCommands,
    bmadCommands: bmadNames(commands),
    externalWrites: false,
  }, null, 2));
} catch (error) {
  if (client) await client.stop().catch(() => undefined);
  console.error(JSON.stringify({
    ok: false,
    packageRoot,
    source,
    tempRoot: tempRoot ?? null,
    error: error instanceof Error ? error.message : String(error),
    externalWrites: false,
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (tempRoot && !keepTemp) fs.rmSync(tempRoot, { recursive: true, force: true });
}
