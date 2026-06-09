import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("Owner release decision status", () => {
  it("is registered and documented as a consolidated read-only owner gate", () => {
    const pkg = JSON.parse(read("package.json")) as { files: string[]; scripts: Record<string, string> };
    const doc = read("docs/owner-release-decision.md");
    const checklist = read("docs/release-checklist-v02.md");

    expect(pkg.files).toContain("scripts/");
    expect(pkg.files).toContain("docs/");
    expect(pkg.scripts["status:owner-release"]).toBe("node scripts/owner-release-decision.mjs");
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "owner-release-decision.mjs"))).toBe(true);
    expect(doc).toContain("npm run status:owner-release");
    expect(doc).toContain("readyForOwnerDecision");
    expect(doc).toContain("It never stages, commits, tags, pushes, publishes to npm, or creates a GitHub release.");
    expect(checklist).toContain("npm run status:owner-release");
  });

  it("summarizes the Owner release gate without external writes", () => {
    const result = spawnSync("node", ["scripts/owner-release-decision.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      readyForOwnerDecision: boolean;
      ownerGated: boolean;
      releaseComplete: boolean;
      externalWrites: boolean;
      checks: Array<{ label: string; ok: boolean }>;
      blockedActionsWithoutOwnerApproval: string[];
    };
    expect(output.ok).toBe(true);
    expect(output.readyForOwnerDecision).toBe(true);
    expect(output.ownerGated).toBe(true);
    expect(output.releaseComplete).toBe(false);
    expect(output.externalWrites).toBe(false);
    expect(output.checks.map((check) => check.label)).toEqual([
      "objective-readiness",
      "context-budget",
      "release-audit",
      "release-scope",
      "publication-status",
    ]);
    expect(output.checks.every((check) => check.ok)).toBe(true);
    expect(output.blockedActionsWithoutOwnerApproval).toContain("git push");
    expect(output.blockedActionsWithoutOwnerApproval).toContain("npm publish");
    expect(JSON.stringify(output)).toContain("smoke:git-install");
    expect(JSON.stringify(output)).toContain("audit:objective:remote");
  });
});
