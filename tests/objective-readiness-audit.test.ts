import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("objective readiness audit", () => {
  it("is registered and documented as a local objective evidence audit", () => {
    const pkg = JSON.parse(read("package.json")) as { files: string[]; scripts: Record<string, string> };
    const readme = read("README.md");
    const checklist = read("docs/release-checklist-v02.md");

    expect(pkg.files).toContain("scripts/");
    expect(pkg.scripts["audit:objective"]).toBe("node scripts/objective-readiness-audit.mjs");
    expect(pkg.scripts["audit:objective:remote"]).toBe("node scripts/objective-readiness-audit.mjs --check-remote --verify-git-install");
    expect(pkg.scripts["audit:context"]).toBe("node scripts/context-budget-audit.mjs");
    expect(pkg.scripts["status:owner-release"]).toBe("node scripts/owner-release-decision.mjs");
    expect(pkg.scripts["smoke:git-install"]).toBe("node scripts/git-install-smoke.mjs");
    expect(pkg.scripts["smoke:commands"]).toBe("node scripts/command-discovery-smoke.mjs");
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "objective-readiness-audit.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "context-budget-audit.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "owner-release-decision.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "git-install-smoke.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "command-discovery-smoke.mjs"))).toBe(true);
    expect(readme).toContain("npm run audit:objective");
    expect(readme).toContain("npm run audit:objective:remote");
    expect(readme).toContain("npm run audit:context");
    expect(readme).toContain("npm run status:owner-release");
    expect(checklist).toContain("npm run audit:objective");
    expect(checklist).toContain("npm run audit:objective:remote");
    expect(checklist).toContain("npm run audit:context");
    expect(checklist).toContain("npm run status:owner-release");
    expect(checklist).toContain("npm run smoke:git-install");
    expect(checklist).toContain("npm run smoke:commands -- --git");
    expect(checklist).toContain("objective audit has no missing local evidence");
  });

  it("passes local evidence while keeping full completion owner-release gated", () => {
    const result = spawnSync("node", ["scripts/objective-readiness-audit.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      completionProven: boolean;
      externalWrites: boolean;
      missing: unknown[];
      ownerGated: Array<{ id: string; status: string; requirement: string; evidence: string[] }>;
    };
    expect(output.ok).toBe(true);
    expect(output.completionProven).toBe(false);
    expect(output.externalWrites).toBe(false);
    expect(output.missing).toHaveLength(0);
    expect(output.ownerGated).toEqual([
      expect.objectContaining({
        id: "R11",
        status: "owner-release-gated",
        requirement: expect.stringContaining("discovers canonical slash commands"),
        evidence: expect.arrayContaining(["scripts/git-install-smoke.mjs", "scripts/command-discovery-smoke.mjs"]),
      }),
    ]);
  });
});
