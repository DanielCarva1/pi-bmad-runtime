import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordRuntimeEvidence } from "../extensions/bmad-runtime/evidence.js";

let tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-evidence-"));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("recordRuntimeEvidence", () => {
  it("creates a runtime command evidence file", () => {
    const root = makeRoot();
    const result = recordRuntimeEvidence(root, {
      command: "/bmad health",
      outcome: "ok",
      summary: "Health passed.",
      counts: { ok: 1 },
    });

    expect(result.relativePath).toBe("_bmad-output/evidence/bmad-runtime-command-evidence.md");
    const text = fs.readFileSync(result.absolutePath, "utf8");
    expect(text).toContain("# BMAD Runtime Command Evidence");
    expect(text).toContain("/bmad health");
    expect(text).toContain("Health passed.");
  });

  it("appends repeated evidence sections without overwriting older content", () => {
    const root = makeRoot();
    const first = recordRuntimeEvidence(root, { command: "/bmad init", outcome: "ok", summary: "First." });
    recordRuntimeEvidence(root, { command: "/bmad health", outcome: "warning", summary: "Second." });

    const text = fs.readFileSync(first.absolutePath, "utf8");
    expect(text).toContain("First.");
    expect(text).toContain("Second.");
    expect((text.match(/^## /gm) ?? []).length).toBe(2);
  });
});
