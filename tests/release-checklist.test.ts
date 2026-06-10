import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("v0.2 release checklist", () => {
  it("documents release tag and install-pin verification without authorizing publication", () => {
    const checklist = read("docs/release-checklist-v02.md");

    expect(checklist).toContain("Use this only after Owner release approval.");
    expect(checklist).toContain("docs/owner-release-runbook-v02.md");
    expect(checklist).toContain("npm run smoke:pi-install");
    expect(checklist).toContain("npm run smoke:commands");
    expect(checklist).toContain("npm run status:publication");
    expect(checklist).toContain("npm run status:owner-release");
    expect(checklist).toContain("npm run status:publication -- --check-remote");
    expect(checklist).toContain("npm run smoke:git-install");
    expect(checklist).toContain("npm run smoke:commands -- --git");
    expect(checklist).toContain("npm run audit:objective:remote");
    expect(checklist).toContain("node scripts/pi-install-smoke.mjs");
    expect(checklist).toContain("git tag v0.2.2");
    expect(checklist).toContain("git push origin v0.2.2");
    expect(checklist).toContain("git ls-remote --tags origin refs/tags/v0.2.2");
    expect(checklist).toContain("pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.2");
    expect(checklist).toContain("remote-tag-missing");
    expect(checklist).toContain("Do not publish to npm unless that is separately approved.");
    expect(checklist).not.toMatch(/autopilot/i);
    expect(checklist).not.toMatch(/Hermes|ZICO/);
  });
});
