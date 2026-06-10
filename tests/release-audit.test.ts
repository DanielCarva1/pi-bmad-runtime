import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("release audit script", () => {
  it("is registered as a local no-publication readiness audit", () => {
    const pkg = JSON.parse(read("package.json")) as { files: string[]; scripts: Record<string, string> };
    const checklist = read("docs/release-checklist-v02.md");
    const readme = read("README.md");

    expect(pkg.files).toContain("scripts/");
    expect(pkg.scripts["audit:release"]).toBe("node scripts/release-audit.mjs");
    expect(pkg.scripts["audit:objective:remote"]).toBe("node scripts/objective-readiness-audit.mjs --check-remote --verify-git-install");
    expect(pkg.scripts["audit:context"]).toBe("node scripts/context-budget-audit.mjs");
    expect(pkg.scripts["status:publication"]).toBe("node scripts/publication-status.mjs");
    expect(pkg.scripts["status:owner-release"]).toBe("node scripts/owner-release-decision.mjs");
    expect(pkg.scripts["smoke:git-install"]).toBe("node scripts/git-install-smoke.mjs");
    expect(pkg.scripts["smoke:commands"]).toBe("node scripts/command-discovery-smoke.mjs");
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "release-audit.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "context-budget-audit.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "publication-status.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "owner-release-decision.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "git-install-smoke.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "command-discovery-smoke.mjs"))).toBe(true);
    expect(checklist).toContain("npm run audit:release");
    expect(checklist).toContain("npm run audit:context");
    expect(checklist).toContain("npm run status:publication");
    expect(checklist).toContain("npm run status:owner-release");
    expect(checklist).toContain("npm run smoke:git-install");
    expect(checklist).toContain("npm run smoke:commands -- --git");
    expect(checklist).toContain("npm run audit:objective:remote");
    expect(checklist).toContain("release audit passes without external writes");
    expect(readme).toContain("npm run audit:release");
  });

  it("passes against the current package shape without external writes", () => {
    const result = spawnSync("node", ["scripts/release-audit.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { ok: boolean; externalWrites: boolean };
    expect(output.ok).toBe(true);
    expect(output.externalWrites).toBe(false);
  });

  it("guards user-facing docs against stale install and recovery wording", () => {
    const audit = read("scripts/release-audit.mjs");
    const prd = read("docs/prd.md");

    expect(prd).toContain("pi install -l <path>");
    expect(prd).not.toContain("pi install <path>");
    expect(audit).toContain("mojibake absent from shipped runtime resources");
    expect(audit).toContain("stale future-flow recovery language absent from shipped runtime resources");
    expect(audit).toContain("internal implementation wording absent from shipped runtime resources");
    expect(audit).toContain("context audit script registered");
    expect(audit).toContain("owner release status script registered");
    expect(audit).toContain("remote objective audit script registered");
  });
});
