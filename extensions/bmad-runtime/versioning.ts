import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { toProjectRelative } from "./paths.js";
import { getProjectIdentityFile } from "./project.js";

export type LocalVersioningChoice = "init" | "skip";

export interface LocalVersioningResult {
  ok: boolean;
  choice: LocalVersioningChoice;
  writeOccurred: boolean;
  gitInitialized: boolean;
  commitCreated: boolean;
  commitMessage?: string;
  commit?: string;
  stagedPaths: string[];
  touchedPaths: string[];
  remotes: string[];
  remoteActionsPerformed: false;
  recoveryAction?: string;
  error?: string;
}

const DEFAULT_STAGE_PATHS = [
  ".bmad-runtime",
  "_bmad-output",
  "_bmad",
  ".pi",
  "docs",
] as const;

function runGit(cwd: string, args: string[]): string {
  return childProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(cwd: string, args: string[]): { ok: true; output: string } | { ok: false; error: string } {
  try {
    return { ok: true, output: runGit(cwd, args) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

function gitAvailable(cwd: string): boolean {
  return tryGit(cwd, ["--version"]).ok;
}

function hasLocalGitDir(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, ".git"));
}

function listRemotes(cwd: string): string[] {
  const result = tryGit(cwd, ["remote"]);
  if (!result.ok || !result.output) return [];
  return result.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function readProjectName(cwd: string): string {
  try {
    const identity = JSON.parse(fs.readFileSync(getProjectIdentityFile(cwd), "utf8")) as { projectName?: unknown };
    if (typeof identity.projectName === "string" && identity.projectName.trim())
      return identity.projectName.trim();
  } catch {
    // Fall through to folder name.
  }
  return path.basename(cwd);
}

function slugForCommitMessage(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || "bmad-project";
}

function existingStagePaths(cwd: string): string[] {
  return DEFAULT_STAGE_PATHS.filter((rel) => fs.existsSync(path.join(cwd, rel)));
}

function stagedPaths(cwd: string): string[] {
  const result = tryGit(cwd, ["diff", "--cached", "--name-only", "--"]);
  if (!result.ok || !result.output) return [];
  return result.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function shortHead(cwd: string): string | undefined {
  const result = tryGit(cwd, ["rev-parse", "--short", "HEAD"]);
  return result.ok && result.output ? result.output : undefined;
}

function failure(input: {
  choice: LocalVersioningChoice;
  writeOccurred: boolean;
  gitInitialized: boolean;
  stagedPaths?: string[];
  touchedPaths?: string[];
  remotes?: string[];
  recoveryAction: string;
  error: string;
}): LocalVersioningResult {
  return {
    ok: false,
    choice: input.choice,
    writeOccurred: input.writeOccurred,
    gitInitialized: input.gitInitialized,
    commitCreated: false,
    stagedPaths: input.stagedPaths ?? [],
    touchedPaths: input.touchedPaths ?? [],
    remotes: input.remotes ?? [],
    remoteActionsPerformed: false,
    recoveryAction: input.recoveryAction,
    error: input.error,
  };
}

export function applyLocalVersioningChoice(
  cwd: string,
  choice: LocalVersioningChoice,
): LocalVersioningResult {
  const root = path.resolve(cwd);
  if (choice === "skip") {
    return {
      ok: true,
      choice,
      writeOccurred: false,
      gitInitialized: false,
      commitCreated: false,
      stagedPaths: [],
      touchedPaths: [],
      remotes: [],
      remoteActionsPerformed: false,
    };
  }

  if (!gitAvailable(root)) {
    return failure({
      choice,
      writeOccurred: false,
      gitInitialized: false,
      recoveryAction: "install-git-and-retry-local-versioning",
      error: "git executable is not available.",
    });
  }

  let writeOccurred = false;
  let gitInitialized = hasLocalGitDir(root);
  const touchedPaths: string[] = [];
  if (!gitInitialized) {
    const init = tryGit(root, ["init"]);
    if (!init.ok) {
      return failure({
        choice,
        writeOccurred: false,
        gitInitialized: false,
        recoveryAction: "inspect-workspace-and-retry-git-init",
        error: init.error,
      });
    }
    gitInitialized = true;
    writeOccurred = true;
    touchedPaths.push(".git");
  }

  const remotes = listRemotes(root);
  if (remotes.length > 0) {
    return failure({
      choice,
      writeOccurred,
      gitInitialized,
      touchedPaths,
      remotes,
      recoveryAction: "remove-or-explicitly-approve-remote-before-local-versioning",
      error: "Local versioning choice must not create or use GitHub/remotes/push.",
    });
  }

  const pathsToStage = existingStagePaths(root);
  if (pathsToStage.length === 0) {
    return failure({
      choice,
      writeOccurred,
      gitInitialized,
      touchedPaths,
      remotes,
      recoveryAction: "create-bmad-scaffold-before-initial-local-commit",
      error: "No BMAD scaffold/artifact paths exist to stage.",
    });
  }

  const add = tryGit(root, ["add", "--", ...pathsToStage]);
  if (!add.ok) {
    return failure({
      choice,
      writeOccurred,
      gitInitialized,
      touchedPaths,
      remotes,
      recoveryAction: "inspect-stage-paths-and-retry-initial-local-commit",
      error: add.error,
    });
  }

  const staged = stagedPaths(root);
  if (staged.length === 0) {
    return {
      ok: true,
      choice,
      writeOccurred,
      gitInitialized,
      commitCreated: false,
      stagedPaths: [],
      touchedPaths,
      remotes,
      remoteActionsPerformed: false,
    };
  }

  const commitMessage = `bmad: initialize ${slugForCommitMessage(readProjectName(root))}`;
  const commit = tryGit(root, [
    "-c",
    "user.name=BMAD Runtime",
    "-c",
    "user.email=bmad-runtime@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-m",
    commitMessage,
  ]);
  if (!commit.ok) {
    return failure({
      choice,
      writeOccurred: true,
      gitInitialized,
      stagedPaths: staged,
      touchedPaths,
      remotes,
      recoveryAction: "inspect-staged-bmad-scaffold-and-retry-commit",
      error: commit.error,
    });
  }

  return {
    ok: true,
    choice,
    writeOccurred: true,
    gitInitialized,
    commitCreated: true,
    commitMessage,
    commit: shortHead(root),
    stagedPaths: staged,
    touchedPaths,
    remotes,
    remoteActionsPerformed: false,
  };
}

export function formatLocalVersioningResult(cwd: string, result: LocalVersioningResult): string {
  const lines = [
    "# Local Versioning",
    "",
    `OK: ${result.ok}`,
    `Choice: ${result.choice}`,
    `Write occurred: ${result.writeOccurred}`,
    `Git initialized: ${result.gitInitialized}`,
    `Commit created: ${result.commitCreated}`,
    `Remote/push/publication: ${result.remoteActionsPerformed ? "performed" : "not performed"}`,
  ];
  if (result.commitMessage) lines.push(`Commit message: ${result.commitMessage}`);
  if (result.commit) lines.push(`Commit: ${result.commit}`);
  if (result.remotes.length) lines.push(`Remotes: ${result.remotes.join(", ")}`);
  if (result.stagedPaths.length) {
    lines.push("", "Staged BMAD paths:");
    for (const staged of result.stagedPaths)
      lines.push(`- ${staged}`);
  }
  if (result.touchedPaths.length) {
    lines.push("", "Touched paths:");
    for (const touched of result.touchedPaths)
      lines.push(`- ${toProjectRelative(cwd, path.join(cwd, touched))}`);
  }
  if (!result.ok) lines.push("", `Recovery: ${result.recoveryAction}`, `Error: ${result.error}`);
  return lines.join("\n");
}
