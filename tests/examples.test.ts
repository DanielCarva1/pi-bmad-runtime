import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REQUIRED_EXAMPLES = [
  "existing-bmad-workspace.md",
  "generic-git-repo.md",
  "local-only-workspace.md",
  "moved-workspace-rebind.md",
  "ambiguous-project-picker.md",
] as const;

function readExample(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), "examples", name), "utf8");
}

function extractSection(content: string, heading: string): string {
  const start = content.indexOf(heading);
  if (start < 0) return "";
  const rest = content.slice(start + heading.length);
  const nextHeading = rest.search(/\n#{1,3} [A-Z]/);
  return nextHeading < 0 ? rest : rest.slice(0, nextHeading);
}

describe("start mode examples", () => {
  it("documents every P0 start mode", () => {
    for (const example of REQUIRED_EXAMPLES) {
      expect(fs.existsSync(path.join(process.cwd(), "examples", example))).toBe(true);
      expect(readExample(example)).toContain("/bmad-start");
    }
  });

  it("documents local-only git without implying GitHub or remote writes", () => {
    const content = readExample("local-only-workspace.md");

    expect(content).toContain("git init: local-only");
    expect(content).toContain("Initial commit message: bmad: initialize");
    expect(content).toContain("GitHub/remote/push: not created automatically");
  });

  it("documents blocked examples with cause, no-write result and recovery", () => {
    for (const example of REQUIRED_EXAMPLES) {
      const content = readExample(example);
      expect(content).toContain("Cause:");
      expect(content).toContain("Write occurred: false");
      expect(content).toContain("Recovery:");
    }
  });

  it("ships examples in package files and avoids separate automation command language", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { files: string[] };
    const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    const combined = REQUIRED_EXAMPLES.map(readExample).join("\n");

    expect(packageJson.files).toContain("examples/");
    expect(readme).toContain("examples/existing-bmad-workspace.md");
    expect(combined).not.toMatch(/autopilot/i);
    expect(combined).not.toMatch(/Hermes|ZICO/);
  });

  it("keeps onboarding docs start-first instead of requiring init before the picker", () => {
    const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    const macbook = fs.readFileSync(path.join(process.cwd(), "docs", "handoff-macbook.md"), "utf8");

    const readmeExistingProject = extractSection(readme, "### Existing BMAD project");
    const readmeTeammate = extractSection(readme, "## Teammate handoff");
    const macbookStart = extractSection(macbook, "## Start BMAD inside Pi");

    for (const section of [readmeExistingProject, readmeTeammate, macbookStart]) {
      expect(section).toContain("/bmad-start");
      expect(section).not.toMatch(/```(?:text|bash)[\s\S]*\/bmad init[\s\S]*\/bmad-start[\s\S]*```/);
      expect(section).not.toMatch(/```(?:text|bash)[\s\S]*\/bmad init[\s\S]*\/bmad start[\s\S]*```/);
    }
  });
});
