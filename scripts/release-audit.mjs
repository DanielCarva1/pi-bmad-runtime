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

function read(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(packageRoot, relativePath));
}

function record(name, ok, details = "") {
  checks.push({ name, ok, details });
}

function requireText(relativePath, needles) {
  const text = read(relativePath);
  const missing = needles.filter((needle) => !text.includes(needle));
  record(`${relativePath} required text`, missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : "ok");
}

function walkFiles(relativePath) {
  const root = path.join(packageRoot, relativePath);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function textFilesUnder(paths) {
  const filePaths = [];
  for (const item of paths) {
    const full = path.join(packageRoot, item);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) filePaths.push(...walkFiles(item));
    else filePaths.push(full);
  }
  return filePaths.filter((file) => /\.(?:md|ts|js|mjs|json|ya?ml|csv|txt)$/i.test(file));
}

const wrongCommand = ["/bmad ", "auto", "pilot"].join("");
const wrongWord = ["auto", "pilot"].join("");
const forkWords = [new RegExp(["Her", "mes"].join(""), "i"), new RegExp(["ZI", "CO"].join(""), "i")];
const forbiddenPatterns = [new RegExp(wrongCommand.replace("/", "\\/"), "i"), new RegExp(`\\b${wrongWord}\\b`, "i"), ...forkWords];
const mojibakePatterns = [
  new RegExp(String.fromCharCode(0x00e2), "i"),
  new RegExp(String.fromCharCode(0x00c3), "i"),
  new RegExp(String.fromCharCode(0xfffd), "i"),
];
const staleRecoveryPatterns = [
  /future\s+(?:dedicated workspace\/picker\/rebind|explicit project picker\/resume|resume\/rebind\/picker|reconcile flow|migration\/reconcile flow|migration flow)/i,
];
const internalProductLanguagePatterns = [
  new RegExp(["in", "this", "story"].join("\\s+"), "i"),
  new RegExp(["writes", "remain", "blocked", "until", "explicit", "selection/rebind/variant", "choice", "is", "implemented"].join("\\s+"), "i"),
];

try {
  const pkg = JSON.parse(read("package.json"));
  record("package version is v0.2.2", pkg.version === "0.2.2", `version=${pkg.version}`);
  record("package name", pkg.name === "pi-bmad-runtime", `name=${pkg.name}`);

  for (const required of ["extensions/", "skills/", "prompts/", "docs/", "examples/", "scripts/", "README.md", "AGENTS.md"]) {
    record(`package files includes ${required}`, Array.isArray(pkg.files) && pkg.files.includes(required), "package.json files");
  }

  record("Pi extension manifest", Array.isArray(pkg.pi?.extensions) && pkg.pi.extensions.includes("./extensions/bmad-runtime/index.ts"), "package.json pi.extensions");
  record("Pi skills manifest", Array.isArray(pkg.pi?.skills) && pkg.pi.skills.includes("./skills"), "package.json pi.skills");
  record("release audit script registered", pkg.scripts?.["audit:release"] === "node scripts/release-audit.mjs", "package.json scripts");
  record("remote objective audit script registered", pkg.scripts?.["audit:objective:remote"] === "node scripts/objective-readiness-audit.mjs --check-remote --verify-git-install", "package.json scripts");
  record("context audit script registered", pkg.scripts?.["audit:context"] === "node scripts/context-budget-audit.mjs", "package.json scripts");
  record("release scope script registered", pkg.scripts?.["status:scope"] === "node scripts/release-scope.mjs", "package.json scripts");
  record("publication status script registered", pkg.scripts?.["status:publication"] === "node scripts/publication-status.mjs", "package.json scripts");
  record("owner release status script registered", pkg.scripts?.["status:owner-release"] === "node scripts/owner-release-decision.mjs", "package.json scripts");
  record("install smoke script registered", pkg.scripts?.["smoke:pi-install"] === "node scripts/pi-install-smoke.mjs", "package.json scripts");
  record("Git install smoke script registered", pkg.scripts?.["smoke:git-install"] === "node scripts/git-install-smoke.mjs", "package.json scripts");
  record("command discovery smoke script registered", pkg.scripts?.["smoke:commands"] === "node scripts/command-discovery-smoke.mjs", "package.json scripts");

  for (const file of [
    "README.md",
    "docs/agent-operating-contract.md",
    "docs/agent-artifact-contract.md",
    "docs/context-budget.md",
    "docs/owner-release-decision.md",
    "docs/self-hosting-isolation.md",
    "docs/release-checklist-v02.md",
    "docs/owner-release-runbook-v02.md",
    "docs/install-smoke.md",
    "scripts/pi-install-smoke.mjs",
    "scripts/git-install-smoke.mjs",
    "scripts/command-discovery-smoke.mjs",
    "scripts/context-budget-audit.mjs",
    "scripts/owner-release-decision.mjs",
    "scripts/release-scope.mjs",
    "scripts/publication-status.mjs",
    "examples/existing-bmad-workspace.md",
    "extensions/bmad-runtime/index.ts",
    "extensions/bmad-runtime/start.ts",
    "extensions/bmad-runtime/resume.ts",
    "extensions/bmad-runtime/phase4-automation.ts",
    "skills/bmad-runtime-for-pi/SKILL.md",
  ]) {
    record(`required file exists: ${file}`, exists(file), file);
  }

  requireText("README.md", [
    "pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.2",
    "pi install -l ../pi-bmad-runtime",
    "pi install -l npm:pi-bmad-runtime@0.2.2",
    "/bmad-start",
    "/bmad start",
    "Use `/bmad init` only as an explicit repair/reconcile command",
    "docs/self-hosting-isolation.md",
  ]);

  requireText("docs/prd.md", [
    "pi install -l <path>",
  ]);

  requireText("docs/release-checklist-v02.md", [
    "docs/owner-release-runbook-v02.md",
    "npm run audit:context",
    "npm run audit:release",
    "npm run status:scope",
    "npm run status:publication",
    "npm run status:owner-release",
    "npm run smoke:pi-install",
    "npm run smoke:git-install",
    "npm run smoke:commands",
    "git tag v0.2.2",
    "git push origin v0.2.2",
    "git ls-remote --tags origin refs/tags/v0.2.2",
    "npm run status:publication -- --check-remote",
    "npm run audit:objective:remote",
    "Do not publish to npm unless that is separately approved.",
  ]);

  requireText("docs/owner-release-runbook-v02.md", [
    "Use this runbook only after the Owner explicitly decides to publish `pi-bmad-runtime v0.2.2` to GitHub.",
    "npm run audit:objective",
    "npm run audit:context",
    "npm run audit:release",
    "npm run status:scope",
    "npm run status:publication",
    "npm run status:owner-release",
    "npm run status:publication -- --check-remote",
    "npm run status:owner-release -- --check-remote",
    "npm run smoke:git-install",
    "npm run smoke:commands",
    "npm run audit:objective:remote",
    "git add <reviewed files>",
    "Do not use `git add .`.",
    "git tag v0.2.2",
    "git push origin v0.2.2",
    "git ls-remote --tags origin refs/tags/v0.2.2",
    "pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.2",
    "Do not publish to npm unless that is separately approved.",
  ]);

  requireText("docs/agent-operating-contract.md", [
    "Chat memory is never source of truth.",
    "## Start State Machine",
    "## Workspace Boundary",
    "docs/agent-artifact-contract.md",
    "docs/context-budget.md",
    "docs/self-hosting-isolation.md",
  ]);

  requireText("docs/agent-artifact-contract.md", [
    "## Sprint Status",
    "development_status:",
    "## Story File",
    "## Agent Scope",
    "## Epic File",
    "## Context Budget",
    "docs/context-budget.md",
  ]);

  requireText("docs/context-budget.md", [
    "npm run audit:context",
    "compact bootstrap corpus",
    "Full BMAD docs are fallback references, not bootstrap input.",
  ]);

  requireText("docs/install-smoke.md", [
    "npm run smoke:pi-install",
    "npm run smoke:git-install",
    "npm run smoke:commands",
    "bmad-command-discovery-failed",
    "reason: remote-tag-missing",
  ]);

  requireText("skills/bmad-runtime-for-pi/SKILL.md", [
    "docs/agent-operating-contract.md",
    "docs/agent-artifact-contract.md",
    "docs/context-budget.md",
    "docs/self-hosting-isolation.md",
    "Phase 3/4: proceed autonomously through the next BMAD workflow unless a true blocker appears.",
  ]);

  requireText("extensions/bmad-runtime/index.ts", [
    "pi.registerCommand(\"bmad-start\"",
    "pi.registerCommand(\"bmad\"",
    "\"resume\"",
    "buildContinuationBootstrapPrompt",
    "findLatestProjectHandoff",
  ]);

  const scannedFiles = textFilesUnder(["extensions", "docs", "skills", "prompts", "README.md", "examples", "scripts"]);
  const forbiddenHits = [];
  const mojibakeHits = [];
  const staleRecoveryHits = [];
  const internalProductLanguageHits = [];
  for (const file of scannedFiles) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(text)) forbiddenHits.push(`${rel(file)}: ${pattern.source}`);
    }
    for (const pattern of mojibakePatterns) {
      if (pattern.test(text)) mojibakeHits.push(`${rel(file)}: ${pattern.source}`);
    }
    for (const pattern of staleRecoveryPatterns) {
      if (pattern.test(text)) staleRecoveryHits.push(`${rel(file)}: ${pattern.source}`);
    }
    for (const pattern of internalProductLanguagePatterns) {
      if (pattern.test(text)) internalProductLanguageHits.push(`${rel(file)}: ${pattern.source}`);
    }
  }
  record("forbidden command/fork language absent from shipped runtime resources", forbiddenHits.length === 0, forbiddenHits.slice(0, 12).join("; ") || "ok");
  record("mojibake absent from shipped runtime resources", mojibakeHits.length === 0, mojibakeHits.slice(0, 12).join("; ") || "ok");
  record("stale future-flow recovery language absent from shipped runtime resources", staleRecoveryHits.length === 0, staleRecoveryHits.slice(0, 12).join("; ") || "ok");
  record("internal implementation wording absent from shipped runtime resources", internalProductLanguageHits.length === 0, internalProductLanguageHits.slice(0, 12).join("; ") || "ok");

  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    packageRoot,
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
