import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProjectInitialized } from "../extensions/bmad-runtime/project.js";
import { applyLocalVersioningChoice } from "../extensions/bmad-runtime/versioning.js";

let tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-versioning-"));
  tempDirs.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return childProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("local versioning choice", () => {
  it("can decline git init without writing", () => {
    const root = makeRoot();
    ensureProjectInitialized(root, { projectName: "Local Idea" });

    const result = applyLocalVersioningChoice(root, "skip");

    expect(result.ok).toBe(true);
    expect(result.writeOccurred).toBe(false);
    expect(result.gitInitialized).toBe(false);
    expect(result.commitCreated).toBe(false);
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
    expect(result.remoteActionsPerformed).toBe(false);
  });

  it("creates an initial local commit with only BMAD scaffold paths staged", () => {
    const root = makeRoot();
    ensureProjectInitialized(root, { projectName: "Local Idea" });
    fs.writeFileSync(path.join(root, "app.ts"), "export const app = true;\n", "utf8");

    const result = applyLocalVersioningChoice(root, "init");

    expect(result.ok).toBe(true);
    expect(result.writeOccurred).toBe(true);
    expect(result.gitInitialized).toBe(true);
    expect(result.commitCreated).toBe(true);
    expect(result.commitMessage).toBe("bmad: initialize local-idea");
    expect(result.remotes).toEqual([]);
    expect(result.remoteActionsPerformed).toBe(false);
    expect(git(root, ["log", "-1", "--pretty=%s"])).toBe("bmad: initialize local-idea");
    const tracked = git(root, ["ls-files"]).split(/\r?\n/).filter(Boolean);
    expect(tracked.some((file) => file.startsWith(".bmad-runtime/"))).toBe(true);
    expect(tracked).not.toContain("app.ts");
    expect(result.stagedPaths.every((file) =>
      file.startsWith(".bmad-runtime/") ||
      file.startsWith("_bmad-output/") ||
      file.startsWith("_bmad/") ||
      file.startsWith(".pi/") ||
      file.startsWith("docs/"),
    )).toBe(true);
  });

  it("blocks local versioning when a remote already exists", () => {
    const root = makeRoot();
    ensureProjectInitialized(root, { projectName: "Remote App" });
    git(root, ["init"]);
    git(root, ["remote", "add", "origin", "https://example.com/acme/remote-app.git"]);

    const result = applyLocalVersioningChoice(root, "init");

    expect(result.ok).toBe(false);
    expect(result.writeOccurred).toBe(false);
    expect(result.gitInitialized).toBe(true);
    expect(result.commitCreated).toBe(false);
    expect(result.remotes).toEqual(["origin"]);
    expect(result.remoteActionsPerformed).toBe(false);
    expect(result.recoveryAction).toBe("remove-or-explicitly-approve-remote-before-local-versioning");
  });
});
