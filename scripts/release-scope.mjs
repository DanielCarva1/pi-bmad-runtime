#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(process.argv.find((arg) => arg.startsWith("--package-root="))?.slice("--package-root=".length) ?? path.join(scriptDir, ".."));

function git(args) {
  const result = spawnSync("git", args, {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error([`git ${args.join(" ")} failed`, result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n"));
  }
  return result.stdout ?? "";
}

function parsePorcelain(line) {
  const status = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  const renameMatch = rawPath.match(/^(.+?)\s+->\s+(.+)$/);
  const filePath = (renameMatch?.[2] ?? rawPath).replaceAll("\\", "/");
  return { status, path: filePath, raw: line };
}

function walkUntrackedDirectory(relativeDir) {
  const root = path.join(packageRoot, relativeDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(path.relative(packageRoot, full).replaceAll(path.sep, "/"));
    }
  }
  return out.sort();
}

function expandUntrackedDirectories(entries) {
  const expanded = [];
  for (const entry of entries) {
    if (entry.status === "??" && entry.path.endsWith("/")) {
      const files = walkUntrackedDirectory(entry.path);
      if (files.length > 0) {
        expanded.push(...files.map((file) => ({ status: "??", path: file, raw: `${entry.raw} -> ${file}`, source: entry.path })));
        continue;
      }
    }
    expanded.push(entry);
  }
  return expanded;
}

function categoryFor(filePath) {
  if (/^(package\.json|package-lock\.json|README\.md|AGENTS\.md)$/.test(filePath)) return "package-metadata";
  if (/^(extensions|skills|prompts|docs|examples|scripts)\//.test(filePath)) return "packaged-resource";
  if (/^tests\//.test(filePath)) return "test";
  if (/^\.pi\/|^\.bmad-runtime\/|^_bmad-output\//.test(filePath)) return "local-runtime-or-evidence";
  return "unclassified";
}

function bucket(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const category = categoryFor(entry.path);
    const current = groups.get(category) ?? [];
    current.push(entry);
    groups.set(category, current);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, items]) => ({
      category,
      count: items.length,
      paths: items.slice(0, 80).map((item) => ({ status: item.status, path: item.path })),
      truncated: items.length > 80,
    }));
}

try {
  const statusLines = git(["status", "--porcelain"]).split(/\r?\n/).filter(Boolean);
  const rawEntries = statusLines.map(parsePorcelain);
  const entries = expandUntrackedDirectories(rawEntries);
  const groups = bucket(entries);
  const unclassified = groups.find((group) => group.category === "unclassified");
  const localRuntime = groups.find((group) => group.category === "local-runtime-or-evidence");

  console.log(JSON.stringify({
    ok: true,
    packageRoot,
    rawDirtyPathCount: rawEntries.length,
    dirtyPathCount: entries.length,
    expandedUntrackedDirectories: rawEntries.filter((entry) => entry.status === "??" && entry.path.endsWith("/")).map((entry) => entry.path),
    groups,
    reviewOrder: [
      "package-metadata",
      "packaged-resource",
      "test",
      "local-runtime-or-evidence",
      "unclassified",
    ],
    warnings: [
      ...(unclassified ? [`Review ${unclassified.count} unclassified path(s) before staging.`] : []),
      ...(localRuntime ? [`Runtime/evidence paths are local artifacts; include only when intentionally publishing evidence.`] : []),
    ],
    suggestedCommands: [
      "git status --short",
      "git diff --stat",
      "git diff -- <path>",
      "git add <reviewed files>",
    ],
    externalWrites: false,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    packageRoot,
    error: error instanceof Error ? error.message : String(error),
    externalWrites: false,
  }, null, 2));
  process.exitCode = 1;
}
