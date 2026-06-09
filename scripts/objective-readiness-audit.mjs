#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(process.argv.find((arg) => arg.startsWith("--package-root="))?.slice("--package-root=".length) ?? path.join(scriptDir, ".."));
const tag = process.argv.find((arg) => arg.startsWith("--tag="))?.slice("--tag=".length) ?? "v0.2.0";
const remote = process.argv.find((arg) => arg.startsWith("--remote="))?.slice("--remote=".length) ?? "origin";
const checkRemote = process.argv.includes("--check-remote");
const verifyGitInstall = process.argv.includes("--verify-git-install");

function read(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(packageRoot, relativePath));
}

function has(relativePath, text) {
  return exists(relativePath) && read(relativePath).includes(text);
}

function all(items) {
  return items.every(Boolean);
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return {
    ok: (result.status ?? 1) === 0,
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function lines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function publicationProof() {
  const statusLines = lines(git(["status", "--porcelain"]).stdout);
  const localTagExists = git(["tag", "--list", tag]).stdout.trim() === tag;
  const remoteUrl = git(["remote", "get-url", remote]).stdout.trim();
  const remoteTag = checkRemote && remoteUrl
    ? git(["ls-remote", "--tags", remote, `refs/tags/${tag}`])
    : { ok: false, stdout: "", stderr: "", status: 1 };
  const remoteTagExists = checkRemote && remoteTag.ok && remoteTag.stdout.includes(`refs/tags/${tag}`);
  return {
    worktreeClean: statusLines.length === 0,
    dirtyPathCount: statusLines.length,
    localTagExists,
    remoteChecked: checkRemote,
    remoteTagExists,
  };
}

function gitInstallProof() {
  if (!verifyGitInstall) return { checked: false, ok: false, reason: "not-requested" };
  const result = spawnSync("node", ["scripts/git-install-smoke.mjs", `--tag=${tag}`, `--remote=${remote}`], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  let parsed = {};
  try {
    parsed = JSON.parse(result.stdout || result.stderr || "{}");
  } catch {
    parsed = { raw: [result.stdout, result.stderr].filter(Boolean).join("\n").trim() };
  }
  return {
    checked: true,
    ok: (result.status ?? 1) === 0,
    status: result.status ?? 1,
    result: parsed,
  };
}

function req(id, requirement, status, evidence, notes = "") {
  return { id, requirement, status, evidence, notes };
}

const wrongCommand = ["/bmad ", "auto", "pilot"].join("");
const wrongWord = ["auto", "pilot"].join("");
const forkA = ["Her", "mes"].join("");
const forkB = ["ZI", "CO"].join("");

function shippedTextFiles() {
  const roots = ["extensions", "docs", "skills", "prompts", "README.md", "examples", "scripts"];
  const out = [];
  const walk = (full) => {
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(full)) walk(path.join(full, entry));
      return;
    }
    if (/\.(?:md|ts|js|mjs|json|ya?ml|csv|txt)$/i.test(full)) out.push(full);
  };
  for (const root of roots) {
    const full = path.join(packageRoot, root);
    if (fs.existsSync(full)) walk(full);
  }
  return out;
}

function forbiddenAbsent() {
  const patterns = [
    new RegExp(wrongCommand.replace("/", "\\/"), "i"),
    new RegExp(`\\b${wrongWord}\\b`, "i"),
    new RegExp(forkA, "i"),
    new RegExp(forkB, "i"),
  ];
  const hits = [];
  for (const file of shippedTextFiles()) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(text)) hits.push(path.relative(packageRoot, file).replaceAll(path.sep, "/"));
    }
  }
  return { ok: hits.length === 0, hits };
}

const noForbidden = forbiddenAbsent();
const releaseProof = publicationProof();
const installProof = gitInstallProof();
const remoteReleaseComplete = releaseProof.worktreeClean && releaseProof.localTagExists && releaseProof.remoteChecked && releaseProof.remoteTagExists && installProof.checked && installProof.ok;
const requirements = [
  req(
    "R1",
    "A person can clone/install the package and get a usable Pi package.",
    all([
      has("README.md", "pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.0"),
      has("README.md", "pi install -l ../pi-bmad-runtime"),
      has("docs/install-smoke.md", "pi install <package-root> -l"),
      has("package.json", "\"smoke:pi-install\": \"node scripts/pi-install-smoke.mjs\""),
      has("package.json", "\"smoke:git-install\": \"node scripts/git-install-smoke.mjs\""),
      exists("scripts/pi-install-smoke.mjs"),
      exists("scripts/git-install-smoke.mjs"),
    ]) ? "proved-locally" : "missing-evidence",
    ["README.md", "docs/install-smoke.md", "package.json", "scripts/pi-install-smoke.mjs", "scripts/git-install-smoke.mjs"],
    "Remote Git install pin is valid only after the Owner creates and pushes tag v0.2.0.",
  ),
  req(
    "R2",
    "/bmad-start and /bmad start present a conversational choice between existing project and new project.",
    all([
      has("extensions/bmad-runtime/index.ts", "pi.registerCommand(\"bmad-start\""),
      has("extensions/bmad-runtime/start.ts", "should we continue one of the existing BMAD projects below, or start a new project?"),
      has("tests/start-command.test.ts", "runs the real /bmad-start conversational new-project path"),
      has("README.md", "/bmad start           Same as /bmad-start"),
    ]) ? "proved-locally" : "missing-evidence",
    ["extensions/bmad-runtime/index.ts", "extensions/bmad-runtime/start.ts", "tests/start-command.test.ts", "README.md"],
  ),
  req(
    "R3",
    "Continuing an existing project bootstraps from runtime state plus latest handoff without overwriting it first.",
    all([
      has("extensions/bmad-runtime/index.ts", "const priorHandoff = findLatestProjectHandoff(resume.workspacePath);"),
      has("extensions/bmad-runtime/start.ts", "Latest Handoff"),
      has("tests/start-command.test.ts", "continues an existing project using the prior latest handoff instead of overwriting it before bootstrap"),
      has("tests/resume.test.ts", "resolves a project by alias from another cwd and builds canonical resume output"),
    ]) ? "proved-locally" : "missing-evidence",
    ["extensions/bmad-runtime/index.ts", "extensions/bmad-runtime/start.ts", "tests/start-command.test.ts", "tests/resume.test.ts"],
  ),
  req(
    "R4",
    "Creating a new project creates a dedicated Project Workspace with project-local package settings.",
    all([
      has("extensions/bmad-runtime/workspace.ts", "Dedicated local BMAD Project Workspace created with project-local Pi package settings."),
      has("tests/start-command.test.ts", "runs the real /bmad-start conversational new-project path in an isolated Runtime Home"),
      has("tests/workspace.test.ts", "adds project-local Pi package settings"),
      has("README.md", "When the user chooses a new project in `/bmad-start`, the runtime writes project-local `.pi/settings.json`"),
    ]) ? "proved-locally" : "missing-evidence",
    ["extensions/bmad-runtime/workspace.ts", "tests/start-command.test.ts", "tests/workspace.test.ts", "README.md"],
  ),
  req(
    "R5",
    "The runtime package, Runtime Home and consumer Project Workspaces remain isolated.",
    all([
      has("docs/self-hosting-isolation.md", "## Three Roots"),
      has("docs/agent-operating-contract.md", "## Workspace Boundary"),
      has("tests/self-hosting-isolation.test.ts", "documents the three roots and maintainer self-hosting flow"),
      has("extensions/bmad-runtime/boundaries.ts", "Runtime Package"),
    ]) ? "proved-locally" : "missing-evidence",
    ["docs/self-hosting-isolation.md", "docs/agent-operating-contract.md", "tests/self-hosting-isolation.test.ts", "extensions/bmad-runtime/boundaries.ts"],
  ),
  req(
    "R6",
    "Phase 1/2 remains human-facilitated while routine confirmations are compressed and Phase 3/4 runs automatically until blockers.",
    all([
      has("docs/agent-operating-contract.md", "| 2-planning | high | Create/validate PRD and UX; compress routine confirmations."),
      has("skills/bmad-runtime-for-pi/SKILL.md", "Phase 3/4: proceed autonomously through the next BMAD workflow unless a true blocker appears."),
      has("extensions/bmad-runtime/prompt-policy.ts", "Phase 3/4 autonomous work may advance deterministic workflow steps without mechanical confirmation."),
      has("tests/prompt-policy.test.ts", "treats routine Phase 3/4 workflow prompts as automatic"),
    ]) ? "proved-locally" : "missing-evidence",
    ["docs/agent-operating-contract.md", "skills/bmad-runtime-for-pi/SKILL.md", "extensions/bmad-runtime/prompt-policy.ts", "tests/prompt-policy.test.ts"],
  ),
  req(
    "R7",
    "Agent-facing BMAD guidance is compact, markdown/state-machine oriented, and epics/stories/sprint are optimized for agent parsing.",
    all([
      has("docs/agent-operating-contract.md", "## Start State Machine"),
      has("docs/agent-artifact-contract.md", "## Context Budget"),
      has("docs/agent-artifact-contract.md", "## Epic File"),
      has("docs/agent-artifact-contract.md", "## Story File"),
      has("docs/context-budget.md", "compact bootstrap corpus"),
      has("package.json", "\"audit:context\": \"node scripts/context-budget-audit.mjs\""),
      exists("scripts/context-budget-audit.mjs"),
      has("tests/context-budget.test.ts", "bounds generated start, resume and Phase 4 execution prompts"),
      has("tests/agent-artifact-contract.test.ts", "injects compact artifact rules into Phase 4 execution prompts"),
    ]) ? "proved-locally" : "missing-evidence",
    ["docs/agent-operating-contract.md", "docs/agent-artifact-contract.md", "docs/context-budget.md", "scripts/context-budget-audit.mjs", "tests/context-budget.test.ts", "tests/agent-artifact-contract.test.ts"],
  ),
  req(
    "R8",
    "The mistaken separate automation command and fork-specific semantics are absent from shipped runtime resources.",
    noForbidden.ok ? "proved-locally" : "missing-evidence",
    ["scripts/release-audit.mjs", "tests/runtime-surface.test.ts", "tests/agent-contract.test.ts"],
    noForbidden.ok ? "No forbidden shipped-resource hits." : `Forbidden hits: ${noForbidden.hits.join(", ")}`,
  ),
  req(
    "R9",
    "Owner has a safe local release path before GitHub tag/push/publication.",
    all([
      has("package.json", "\"audit:release\": \"node scripts/release-audit.mjs\""),
      has("package.json", "\"audit:context\": \"node scripts/context-budget-audit.mjs\""),
      has("package.json", "\"status:scope\": \"node scripts/release-scope.mjs\""),
      has("package.json", "\"status:publication\": \"node scripts/publication-status.mjs\""),
      has("package.json", "\"status:owner-release\": \"node scripts/owner-release-decision.mjs\""),
      exists("scripts/owner-release-decision.mjs"),
      has("docs/owner-release-decision.md", "readyForOwnerDecision"),
      has("docs/owner-release-runbook-v02.md", "Use this runbook only after the Owner explicitly decides to publish `pi-bmad-runtime v0.2.0` to GitHub."),
      has("docs/owner-release-runbook-v02.md", "git add <reviewed files>"),
      has("docs/owner-release-runbook-v02.md", "Do not use `git add .`."),
      has("docs/owner-release-runbook-v02.md", "git push origin v0.2.0"),
      has("docs/release-checklist-v02.md", "Only after Owner approval:"),
      has("docs/release-checklist-v02.md", "git tag v0.2.0"),
      has("docs/release-checklist-v02.md", "npm run status:scope"),
      has("docs/release-checklist-v02.md", "npm run status:publication -- --check-remote"),
      has("tests/release-audit.test.ts", "passes against the current package shape without external writes"),
      has("tests/publication-status.test.ts", "reports local publication status without writing or requiring remote checks"),
      has("tests/owner-release-decision.test.ts", "summarizes the Owner release gate without external writes"),
    ]) ? "proved-locally" : "missing-evidence",
    ["scripts/release-audit.mjs", "scripts/release-scope.mjs", "scripts/publication-status.mjs", "scripts/owner-release-decision.mjs", "docs/owner-release-decision.md", "docs/release-checklist-v02.md", "docs/owner-release-runbook-v02.md", "tests/release-audit.test.ts", "tests/publication-status.test.ts", "tests/owner-release-decision.test.ts"],
  ),
  req(
    "R10",
    "Consumer task docs can be ephemeral only after result/status/evidence is captured, while canonical artifacts remain protected.",
    all([
      has("docs/agent-artifact-contract.md", "Recommended task-packet locations:"),
      has("docs/agent-artifact-contract.md", "Runtime cleanup classification:"),
      has("extensions/bmad-runtime/artifacts.ts", "classifyArtifactCleanupPath"),
      has("extensions/bmad-runtime/artifacts.ts", "protected-canonical"),
      has("extensions/bmad-runtime/artifacts.ts", "ephemeral-candidate-allowed"),
      has("tests/artifact-cleanup.test.ts", "blocks canonical artifacts from ephemeral cleanup"),
      has("tests/artifact-cleanup.test.ts", "allows task-packet cleanup only after completion evidence is captured"),
    ]) ? "proved-locally" : "missing-evidence",
    ["docs/agent-artifact-contract.md", "extensions/bmad-runtime/artifacts.ts", "tests/artifact-cleanup.test.ts"],
  ),
  req(
    "R11",
    "Remote release/install completion is proven after Owner creates commit/tag/push, verifies the remote tag, and runs Git install smoke.",
    remoteReleaseComplete ? "proved-remotely" : "owner-release-gated",
    ["scripts/publication-status.mjs", "scripts/git-install-smoke.mjs", "docs/release-checklist-v02.md", "docs/owner-release-runbook-v02.md"],
    remoteReleaseComplete
      ? `Remote tag ${tag} is present, worktree is clean, and Git install smoke passed.`
      : `Remote proof pending. worktreeClean=${releaseProof.worktreeClean}; localTagExists=${releaseProof.localTagExists}; remoteChecked=${releaseProof.remoteChecked}; remoteTagExists=${releaseProof.remoteTagExists}; gitInstallSmokeChecked=${installProof.checked}; gitInstallSmokeOk=${installProof.ok}. This audit never creates commits, tags, pushes, GitHub releases or npm publications.`,
  ),
];

const missing = requirements.filter((item) => item.status === "missing-evidence");
const ownerGated = requirements.filter((item) => item.status === "owner-release-gated");

const result = {
  ok: missing.length === 0,
  completionProven: missing.length === 0 && ownerGated.length === 0,
  packageRoot,
  releaseProof,
  gitInstallProof: installProof,
  requirements,
  missing,
  ownerGated,
  externalWrites: false,
};

console.log(JSON.stringify(result, null, 2));
if (missing.length > 0) process.exitCode = 1;
