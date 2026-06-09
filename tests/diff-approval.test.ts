import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateDiffApprovalPolicy, formatDiffApprovalPolicy } from "../extensions/bmad-runtime/diff-approval.js";

let tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-diff-approval-"));
  tempDirs.push(root);
  return root;
}

function writeSettings(root: string, packages: unknown[]): void {
  const file = path.join(root, ".pi", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ packages }, null, 2), "utf8");
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("diff approval policy", () => {
  it("treats missing pi-show-diffs as non-blocking evidence", () => {
    const policy = evaluateDiffApprovalPolicy(makeRoot());

    expect(policy.configured).toBe(false);
    expect(policy.mode).toBe("not-installed");
    expect(policy.blocking).toBe(false);
    expect(policy.evidence.join("\n")).toContain("not configured");
  });

  it("allows explicit auto-approval or bypass", () => {
    const root = makeRoot();
    writeSettings(root, [{ source: "pi-show-diffs", autoApprove: true }]);

    const policy = evaluateDiffApprovalPolicy(root);

    expect(policy.mode).toBe("bypass");
    expect(policy.blocking).toBe(false);
    expect(policy.bypassAllowed).toBe(true);
    expect(formatDiffApprovalPolicy(policy)).toContain("blocking: no");
  });

  it("allows nested package config for auto-approval", () => {
    const root = makeRoot();
    writeSettings(root, [{ source: "pi-show-diffs", settings: { autoApprove: true } }]);

    const policy = evaluateDiffApprovalPolicy(root);

    expect(policy.mode).toBe("bypass");
    expect(policy.blocking).toBe(false);
  });

  it("blocks explicit manual approval mode", () => {
    const root = makeRoot();
    writeSettings(root, [{ source: "pi-show-diffs", approval: "manual" }]);

    const policy = evaluateDiffApprovalPolicy(root);

    expect(policy.mode).toBe("blocking");
    expect(policy.blocking).toBe(true);
    expect(policy.blockers.join("\n")).toContain("Configure diff approval");
  });

  it("treats explicit non-blocking boolean config as safe", () => {
    const root = makeRoot();
    writeSettings(root, [{ source: "pi-show-diffs", requiresApproval: false }]);

    const policy = evaluateDiffApprovalPolicy(root);

    expect(policy.mode).toBe("safe");
    expect(policy.blocking).toBe(false);
  });

  it("treats unconfigured pi-show-diffs as an unknown blocking risk", () => {
    const root = makeRoot();
    writeSettings(root, ["pi-show-diffs"]);

    const policy = evaluateDiffApprovalPolicy(root);

    expect(policy.mode).toBe("unknown");
    expect(policy.blocking).toBe(true);
    expect(policy.blockers.join("\n")).toContain("mandatory prompt/modal");
  });
});
