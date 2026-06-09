import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPiNativeP0Smoke, validatePiNativePackage } from "../extensions/bmad-runtime/pi-native.js";

let tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-native-"));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("Pi-native P0 behavior", () => {
  it("keeps the Pi package extension, skills and prompts registered", () => {
    const checks = validatePiNativePackage(process.cwd());

    expect(checks.filter((check) => !check.ok)).toEqual([]);
    expect(checks.map((check) => check.label)).toContain("pi-extension-entry");
    expect(checks.map((check) => check.label)).toContain("pi-skills-entry");
    expect(checks.map((check) => check.label)).toContain("pi-prompts-entry");
  });

  it("keeps external adapters future-only instead of replacing Pi-native P0", () => {
    const checks = validatePiNativePackage(process.cwd());
    const future = checks.find((check) => check.label === "external-adapters-future-only");

    expect(future?.ok).toBe(true);
    expect(future?.detail).toContain("Pi-native P0");
  });

  it("runs a local P0 smoke for path normalization, command execution and artifact IO", () => {
    const root = makeRoot();
    const report = runPiNativeP0Smoke(root);

    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.checks.map((check) => check.label)).toEqual([
      "path-normalization",
      "command-execution",
      "artifact-read-write",
    ]);
    expect(report.evidencePath).toBe("_bmad-output/evidence/pi-native-p0-smoke.md");
    expect(fs.existsSync(path.join(root, report.evidencePath))).toBe(true);
  });
});
