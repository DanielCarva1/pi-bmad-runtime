#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(process.argv.find((arg) => arg.startsWith("--package-root="))?.slice("--package-root=".length) ?? path.join(scriptDir, ".."));

const checks = [];

function rel(file) {
  return path.relative(packageRoot, file).replaceAll(path.sep, "/");
}

function full(relativePath) {
  return path.join(packageRoot, relativePath);
}

function exists(relativePath) {
  return fs.existsSync(full(relativePath));
}

function read(relativePath) {
  return fs.readFileSync(full(relativePath), "utf8");
}

function record(name, ok, details = "") {
  checks.push({ name, ok, details });
}

function fileStats(relativePath) {
  const text = read(relativePath);
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    lines: text.split(/\r?\n/).length,
    text,
  };
}

function requireBudget(relativePath, maxBytes, maxLines) {
  if (!exists(relativePath)) {
    record(`${relativePath} exists`, false, "missing");
    return;
  }
  const stats = fileStats(relativePath);
  record(`${relativePath} bytes <= ${maxBytes}`, stats.bytes <= maxBytes, `${stats.bytes} bytes`);
  record(`${relativePath} lines <= ${maxLines}`, stats.lines <= maxLines, `${stats.lines} lines`);
}

function walkFiles(relativePath) {
  const root = full(relativePath);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) out.push(child);
    }
  }
  return out;
}

function textFilesUnder(paths) {
  const out = [];
  for (const item of paths) {
    const target = full(item);
    if (!fs.existsSync(target)) continue;
    if (fs.statSync(target).isDirectory()) out.push(...walkFiles(item));
    else out.push(target);
  }
  return out.filter((file) => /\.(?:md|ts|js|mjs|json|ya?ml|csv|txt)$/i.test(file));
}

function requireText(relativePath, needles) {
  const text = read(relativePath);
  const missing = needles.filter((needle) => !text.includes(needle));
  record(`${relativePath} required text`, missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : "ok");
}

try {
  const pkg = JSON.parse(read("package.json"));
  record("context audit script registered", pkg.scripts?.["audit:context"] === "node scripts/context-budget-audit.mjs", "package.json scripts");

  requireBudget("docs/agent-operating-contract.md", 6000, 120);
  requireBudget("docs/agent-artifact-contract.md", 5500, 170);
  requireBudget("docs/context-budget.md", 4500, 100);
  requireBudget("skills/bmad-runtime-for-pi/SKILL.md", 7000, 150);

  const promptFiles = walkFiles("prompts").filter((file) => file.endsWith(".md"));
  record("prompt files exist", promptFiles.length > 0, `${promptFiles.length} files`);
  for (const file of promptFiles) {
    const relativePath = rel(file);
    const text = fs.readFileSync(file, "utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    const lines = text.split(/\r?\n/).length;
    record(`${relativePath} bytes <= 1500`, bytes <= 1500, `${bytes} bytes`);
    record(`${relativePath} lines <= 60`, lines <= 60, `${lines} lines`);
  }

  const compactSet = [
    "docs/agent-operating-contract.md",
    "docs/agent-artifact-contract.md",
    "docs/context-budget.md",
    "skills/bmad-runtime-for-pi/SKILL.md",
    ...promptFiles.map(rel),
  ];
  const totalBytes = compactSet
    .filter(exists)
    .map((relativePath) => Buffer.byteLength(read(relativePath), "utf8"))
    .reduce((sum, value) => sum + value, 0);
  record("compact bootstrap corpus <= 25000 bytes", totalBytes <= 25000, `${totalBytes} bytes across ${compactSet.length} files`);

  requireText("docs/context-budget.md", [
    "npm run audit:context",
    "compact bootstrap corpus",
    "Full BMAD docs are fallback references, not bootstrap input.",
  ]);
  requireText("docs/agent-operating-contract.md", [
    "docs/context-budget.md",
    "Full BMAD docs only when the active workflow needs a specific rule not covered above",
  ]);
  requireText("docs/agent-artifact-contract.md", [
    "docs/context-budget.md",
    "Before reading long artifacts, the agent should build a compact working set",
  ]);
  requireText("skills/bmad-runtime-for-pi/SKILL.md", [
    "docs/context-budget.md",
    "Do not load full BMAD docs or long artifacts unless the next action requires them.",
  ]);

  const longDocFile = ["llms", "full.txt"].join("-");
  const longDocDomain = ["bmad", "method.org"].join("-");
  const scannedFiles = textFilesUnder(["extensions", "skills", "prompts", "docs", "README.md", "examples"]);
  const longDocHits = [];
  for (const file of scannedFiles) {
    const text = fs.readFileSync(file, "utf8");
    if (text.includes(longDocFile) || text.includes(longDocDomain)) longDocHits.push(rel(file));
  }
  record("long BMAD source docs are not referenced as runtime prompt input", longDocHits.length === 0, longDocHits.join(", ") || "ok");

  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    packageRoot,
    compactBootstrapBytes: totalBytes,
    checks,
    failed,
    externalWrites: false,
  }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    packageRoot,
    error: error instanceof Error ? error.message : String(error),
    externalWrites: false,
  }, null, 2));
  process.exitCode = 1;
}
