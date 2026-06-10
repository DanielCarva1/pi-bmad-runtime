import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("publication status script", () => {
  it("is registered and documented as a read-only release status check", () => {
    const pkg = JSON.parse(read("package.json")) as { files: string[]; scripts: Record<string, string> };
    const checklist = read("docs/release-checklist-v02.md");
    const readme = read("README.md");

    expect(pkg.files).toContain("scripts/");
    expect(pkg.scripts["status:publication"]).toBe("node scripts/publication-status.mjs");
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "publication-status.mjs"))).toBe(true);
    expect(readme).toContain("npm run status:publication");
    expect(checklist).toContain("npm run status:publication");
    expect(checklist).toContain("npm run status:publication -- --check-remote");
    expect(checklist).toContain("read-only checks; they do not commit, tag, or push");
  });

  it("reports local publication status without writing or requiring remote checks", () => {
    const result = spawnSync("node", ["scripts/publication-status.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      tag: string;
      remoteChecked: boolean;
      releaseComplete: boolean;
      externalWrites: boolean;
      nextActions: string[];
    };
    expect(output.ok).toBe(true);
    expect(output.tag).toBe("v0.2.1");
    expect(output.remoteChecked).toBe(false);
    expect(output.externalWrites).toBe(false);
    expect(output.nextActions.join("\n")).toContain("--check-remote");
    expect(typeof output.releaseComplete).toBe("boolean");
  });
});
