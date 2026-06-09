import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("agent operating contract", () => {
  it("ships a compact state-machine contract for the Pi agent", () => {
    const contract = read("docs/agent-operating-contract.md");
    const pkg = JSON.parse(read("package.json")) as { files: string[] };

    expect(pkg.files).toContain("docs/");
    expect(contract).toContain("## Start State Machine");
    expect(contract).toContain("## Phase Policy");
    expect(contract).toContain("5-ready-for-use");
    expect(contract).toContain("do not resume Phase 4 story automation");
    expect(contract).toContain("## Artifact Policy");
    expect(contract).toContain("Chat memory is never source of truth.");
    expect(contract).toContain("/bmad-start");
    expect(contract).toContain("/bmad start");
    expect(contract).not.toMatch(/\/bmad autopilot/i);
    expect(contract).not.toMatch(/Hermes|ZICO/);
  });

  it("makes the orchestrator skill prefer the compact contract before long docs", () => {
    const skill = read("skills/bmad-runtime-for-pi/SKILL.md");

    expect(skill).toContain("docs/agent-operating-contract.md");
    expect(skill).toContain("5-ready-for-use");
    expect(skill).toContain("compact operating contract");
    expect(skill).toContain("before loading long BMAD documentation");
    expect(skill).not.toMatch(/\/bmad autopilot/i);
    expect(skill).not.toMatch(/Hermes|ZICO/);
  });
});
