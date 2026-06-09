import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("release scope script", () => {
  it("is registered and documented as a read-only staging-scope aid", () => {
    const pkg = JSON.parse(read("package.json")) as { files: string[]; scripts: Record<string, string> };
    const checklist = read("docs/release-checklist-v02.md");
    const readme = read("README.md");

    expect(pkg.files).toContain("scripts/");
    expect(pkg.scripts["status:scope"]).toBe("node scripts/release-scope.mjs");
    expect(fs.existsSync(path.join(process.cwd(), "scripts", "release-scope.mjs"))).toBe(true);
    expect(readme).toContain("npm run status:scope");
    expect(checklist).toContain("npm run status:scope");
    expect(checklist).toContain("does not run `git add`");
  });

  it("reports dirty paths by release review category without writing", () => {
    const result = spawnSync("node", ["scripts/release-scope.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      dirtyPathCount: number;
      rawDirtyPathCount: number;
      expandedUntrackedDirectories: string[];
      groups: Array<{ category: string; count: number }>;
      reviewOrder: string[];
      externalWrites: boolean;
      suggestedCommands: string[];
    };
    expect(output.ok).toBe(true);
    expect(output.externalWrites).toBe(false);
    expect(typeof output.dirtyPathCount).toBe("number");
    expect(typeof output.rawDirtyPathCount).toBe("number");
    expect(Array.isArray(output.expandedUntrackedDirectories)).toBe(true);
    expect(output.groups.every((group) => typeof group.category === "string" && typeof group.count === "number")).toBe(true);
    expect(output.groups.flatMap((group: any) => group.paths ?? []).some((item: any) => typeof item.path === "string" && item.path.endsWith("/"))).toBe(false);
    expect(output.reviewOrder).toContain("packaged-resource");
    expect(output.suggestedCommands).toContain("git add <reviewed files>");
  });
});
