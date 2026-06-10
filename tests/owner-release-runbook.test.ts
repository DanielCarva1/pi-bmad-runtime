import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("Owner release runbook v0.2", () => {
  it("documents a reviewed, Owner-gated GitHub release path", () => {
    const pkg = JSON.parse(read("package.json")) as { files: string[] };
    const runbook = read("docs/owner-release-runbook-v02.md");
    const checklist = read("docs/release-checklist-v02.md");

    expect(pkg.files).toContain("docs/");
    expect(checklist).toContain("docs/owner-release-runbook-v02.md");
    expect(runbook).toContain("Use this runbook only after the Owner explicitly decides to publish `pi-bmad-runtime v0.2.1` to GitHub.");
    expect(runbook).toContain("npm run audit:objective");
    expect(runbook).toContain("npm run audit:release");
    expect(runbook).toContain("npm run status:scope");
    expect(runbook).toContain("npm run status:publication");
    expect(runbook).toContain("npm run status:owner-release");
    expect(runbook).toContain("npm run status:publication -- --check-remote");
    expect(runbook).toContain("npm run status:owner-release -- --check-remote");
    expect(runbook).toContain("npm run smoke:git-install");
    expect(runbook).toContain("npm run smoke:commands");
    expect(runbook).toContain("npm run smoke:commands -- --git");
    expect(runbook).toContain("npm run audit:objective:remote");
    expect(runbook).toContain("git add <reviewed files>");
    expect(runbook).toContain("Do not use `git add .`.");
    expect(runbook).toContain("git tag v0.2.1");
    expect(runbook).toContain("git push origin v0.2.1");
    expect(runbook).toContain("git ls-remote --tags origin refs/tags/v0.2.1");
    expect(runbook).toContain("pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.1");
    expect(runbook).toContain("not fully objective-proven until `npm run smoke:git-install`, `npm run smoke:commands -- --git`, and `npm run audit:objective:remote` pass");
    expect(runbook).toContain("Do not publish to npm unless that is separately approved.");
    expect(runbook).not.toMatch(/auto\s*pilot/i);
    expect(runbook).not.toMatch(/Hermes|ZICO/);
  });

  it("is enforced by the release and objective audits without external writes", () => {
    const release = spawnSync("node", ["scripts/release-audit.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    expect(release.stderr).toBe("");
    expect(release.status).toBe(0);
    const releaseOutput = JSON.parse(release.stdout) as { ok: boolean; externalWrites: boolean; checks: Array<{ name: string }> };
    expect(releaseOutput.ok).toBe(true);
    expect(releaseOutput.externalWrites).toBe(false);
    expect(releaseOutput.checks.some((check) => check.name === "docs/owner-release-runbook-v02.md required text")).toBe(true);

    const objective = spawnSync("node", ["scripts/objective-readiness-audit.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    expect(objective.stderr).toBe("");
    expect(objective.status).toBe(0);
    const objectiveOutput = JSON.parse(objective.stdout) as {
      ok: boolean;
      externalWrites: boolean;
      requirements: Array<{ id: string; evidence: string[] }>;
    };
    expect(objectiveOutput.ok).toBe(true);
    expect(objectiveOutput.externalWrites).toBe(false);
    expect(objectiveOutput.requirements.find((item) => item.id === "R9")?.evidence).toContain("docs/owner-release-runbook-v02.md");
    expect(objectiveOutput.requirements.find((item) => item.id === "R9")?.evidence).toContain("scripts/owner-release-decision.mjs");
    expect(objectiveOutput.requirements.find((item) => item.id === "R11")?.evidence).toContain("docs/owner-release-runbook-v02.md");
    expect(objectiveOutput.requirements.find((item) => item.id === "R11")?.evidence).toContain("scripts/git-install-smoke.mjs");
    expect(objectiveOutput.requirements.find((item) => item.id === "R11")?.evidence).toContain("scripts/command-discovery-smoke.mjs");
  });
});
