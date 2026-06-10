import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("self-hosting and workspace isolation contract", () => {
  it("documents the three roots and maintainer self-hosting flow", () => {
    const doc = read("docs/self-hosting-isolation.md");
    const pkg = JSON.parse(read("package.json")) as { files: string[] };

    expect(pkg.files).toContain("docs/");
    expect(doc).toContain("## Three Roots");
    expect(doc).toContain("Runtime Package");
    expect(doc).toContain("Runtime Home");
    expect(doc).toContain("Project Workspace");
    expect(doc).toContain("pi-bmad-runtime/");
    expect(doc).toContain("~/.pi/agent/bmad-runtime/");
    expect(doc).toContain("~/.pi/agent/bmad-runtime/projects.json");
    expect(doc).toContain("guardinha-noturno");
    expect(doc).toContain("pi-bmad-builder");
    expect(doc).toContain("pi install -l <path-to-pi-bmad-runtime>");
    expect(doc).toContain("pi -e <path-to-pi-bmad-runtime>");
    expect(doc).toContain("pi install -l git:github.com/DanielCarva1/pi-bmad-runtime@v0.2.1");
    expect(doc).toContain("For one Pi session, load the runtime once.");
    expect(doc).toContain("/bmad-start:1");
    expect(doc).toContain("/bmad-start");
    expect(doc).toContain("/bmad start");
    expect(doc).toContain("/bmad status");
    expect(doc).toContain("/bmad projects");
    expect(doc).not.toMatch(/\/bmad autopilot/i);
    expect(doc).not.toMatch(/Hermes|ZICO/);
  });

  it("makes the agent contract and README point at the isolation guide", () => {
    const contract = read("docs/agent-operating-contract.md");
    const skill = read("skills/bmad-runtime-for-pi/SKILL.md");
    const readme = read("README.md");

    expect(contract).toContain("## Workspace Boundary");
    expect(contract).toContain("docs/self-hosting-isolation.md");
    expect(contract).toContain("Runtime Package");
    expect(contract).toContain("Runtime Home");
    expect(contract).toContain("Project Workspace");
    expect(skill).toContain("docs/self-hosting-isolation.md");
    expect(skill).toContain("workspace boundaries");
    expect(readme).toContain("docs/self-hosting-isolation.md");
  });
});
