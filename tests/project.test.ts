import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProjectInitialized, getBaselineLockFile, getProjectIdentityFile } from "../extensions/bmad-runtime/project.js";
import { getStateFile } from "../extensions/bmad-runtime/state.js";

let tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-project-init-"));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("ensureProjectInitialized", () => {
  it("creates runtime state, project identity, baseline lock, and artifact roots", () => {
    const root = makeRoot();
    const result = ensureProjectInitialized(root);

    expect(fs.existsSync(getStateFile(root))).toBe(true);
    expect(fs.existsSync(getProjectIdentityFile(root))).toBe(true);
    expect(fs.existsSync(getBaselineLockFile(root))).toBe(true);
    expect(fs.existsSync(path.join(root, "_bmad-output", "planning-artifacts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "_bmad-output", "implementation-artifacts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "docs"))).toBe(true);
    expect(result.identity.projectId).toMatch(/[0-9a-f-]{36}/i);
    expect(result.created).toContain(".bmad-runtime/state.json");
    expect(result.created).toContain(".bmad-runtime/project-identity.json");
    expect(result.created).toContain(".bmad-runtime/baseline-lock.json");
  });

  it("is idempotent and preserves an existing project id", () => {
    const root = makeRoot();
    const first = ensureProjectInitialized(root);
    const second = ensureProjectInitialized(root);

    expect(second.identity.projectId).toBe(first.identity.projectId);
    expect(second.created).toHaveLength(0);
    expect(second.reused).toContain(".bmad-runtime/project-identity.json");
    expect(second.reused).toContain(".bmad-runtime/baseline-lock.json");
  });

  it("does not overwrite existing runtime state", () => {
    const root = makeRoot();
    ensureProjectInitialized(root);
    const stateFile = getStateFile(root);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    state.track = "custom";
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    ensureProjectInitialized(root);

    const after = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    expect(after.track).toBe("custom");
  });
});
