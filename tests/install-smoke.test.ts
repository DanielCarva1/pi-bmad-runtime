import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("Pi install smoke script", () => {
  it("declares a repeatable local install smoke without making it the default test path", () => {
    const pkg = JSON.parse(read("package.json")) as { files: string[]; scripts: Record<string, string> };

    expect(pkg.files).toContain("scripts/");
    expect(pkg.scripts["smoke:pi-install"]).toBe("node scripts/pi-install-smoke.mjs");
    expect(pkg.scripts["smoke:git-install"]).toBe("node scripts/git-install-smoke.mjs");
    expect(pkg.scripts["smoke:commands"]).toBe("node scripts/command-discovery-smoke.mjs");
    expect(pkg.scripts.smoke).not.toContain("smoke:pi-install");
    expect(pkg.scripts.smoke).not.toContain("smoke:git-install");
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "pi-install-smoke.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "git-install-smoke.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "command-discovery-smoke.mjs"))).toBe(true);
  });

  it("documents the install smokes and their no-publication boundary", () => {
    const doc = read("docs/install-smoke.md");

    expect(doc).toContain("npm run smoke:pi-install");
    expect(doc).toContain("npm run smoke:git-install");
    expect(doc).toContain("npm run smoke:commands");
    expect(doc).toContain("pi install <package-root> -l");
    expect(doc).toContain("pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.2");
    expect(doc).toContain("pi list");
    expect(doc).toContain("bmad-command-discovery-failed");
    expect(doc).toContain("reason: remote-tag-missing");
    expect(doc).toContain("does not publish, push, tag, deploy");
    expect(doc).not.toMatch(/autopilot/i);
  });

  it("can dry-run the Git install smoke without cloning or writing outside a temp project", () => {
    const result = spawnSync("node", ["scripts/git-install-smoke.mjs", "--dry-run", "--skip-remote-check"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      dryRun: boolean;
      source: string;
      installAttempted: boolean;
      externalWrites: boolean;
    };
    expect(output.ok).toBe(true);
    expect(output.dryRun).toBe(true);
    expect(output.source).toBe("git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.2");
    expect(output.installAttempted).toBe(false);
    expect(output.externalWrites).toBe(false);
  });

  it("can dry-run the command discovery smoke without starting Pi RPC", () => {
    const result = spawnSync("node", ["scripts/command-discovery-smoke.mjs", "--dry-run"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      dryRun: boolean;
      requiredCommands: string[];
      externalWrites: boolean;
    };
    expect(output.ok).toBe(true);
    expect(output.dryRun).toBe(true);
    expect(output.requiredCommands).toEqual(["bmad", "bmad-start", "bmad-help"]);
    expect(output.externalWrites).toBe(false);
  });
});
