import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectProjectOwnedArtifactReferences, createRuntimeHomeEvidencePointer, detectCredentialRequirement, recordRuntimeEvidence, redactSecrets, validateProjectOwnedArtifactReferences } from "../extensions/bmad-runtime/evidence.js";

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
    expect(result.runtimeHomePointer).toMatchObject({
      kind: "workflow",
      relativePath: "_bmad-output/evidence/bmad-runtime-command-evidence.md",
      format: "markdown",
      projectOwned: true,
      contentStored: false,
    });
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

  it("keeps Runtime Home references metadata-only", () => {
    const root = makeRoot();
    const evidencePath = path.join(root, "_bmad-output", "evidence", "decision.md");
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, "# Canonical decision content\n", "utf8");

    const pointer = createRuntimeHomeEvidencePointer(root, evidencePath, "decision");

    expect(pointer.relativePath).toBe("_bmad-output/evidence/decision.md");
    expect(pointer.contentStored).toBe(false);
    expect(JSON.stringify(pointer)).not.toContain("Canonical decision content");
  });

  it("validates project-owned artifact references and missing paths", () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "_bmad-output", "evidence"), { recursive: true });
    fs.writeFileSync(path.join(root, "_bmad-output", "evidence", "exists.md"), "# Evidence\n", "utf8");

    const refs = collectProjectOwnedArtifactReferences([
      "Evidence: _bmad-output/evidence/exists.md",
      "Missing: _bmad-output/evidence/missing.md",
      "State: .bmad-runtime/state.json",
    ].join("\n"));
    const validation = validateProjectOwnedArtifactReferences(root, refs);

    expect(refs).toContain("_bmad-output/evidence/exists.md");
    expect(validation.missing).toEqual(["_bmad-output/evidence/missing.md", ".bmad-runtime/state.json"]);
    expect(validation.writeOccurred).toBe(false);
  });

  it("redacts common secret patterns before persisting runtime evidence", () => {
    const root = makeRoot();
    const openAiKey = "sk-test_abcdefghijklmnopqrstuvwxyz123456";
    const githubToken = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const result = recordRuntimeEvidence(root, {
      command: "/bmad health",
      outcome: "blocked",
      summary: `token=${openAiKey}`,
      touchedPaths: [`docs/output-${githubToken}.md`],
      details: {
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456",
        nested: { password: "supersecret-value" },
      },
    });

    const text = fs.readFileSync(result.absolutePath, "utf8");
    expect(text).toContain("[REDACTED:");
    expect(text).toContain("Redactions:");
    expect(text).not.toContain(openAiKey);
    expect(text).not.toContain(githubToken);
    expect(text).not.toContain("supersecret-value");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("redacts fixtures without leaving raw simulated secrets", () => {
    const raw = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      "api_key=sk-test_abcdefghijklmnopqrstuvwxyz123456",
      "aws=AKIAABCDEFGHIJKLMNOP",
    ].join("\n");

    const redacted = redactSecrets(raw);

    expect(redacted.redactionCount).toBeGreaterThanOrEqual(3);
    expect(redacted.value).not.toContain("sk-test_abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted.value).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(redacted.value).toContain("[REDACTED:");
  });

  it("detects credential requirements and records approval blocker without raw values", () => {
    const root = makeRoot();
    const rawToken = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const reasons = detectCredentialRequirement("Missing API key for provider; user must provide token.");

    const result = recordRuntimeEvidence(root, {
      command: "/bmad run next",
      outcome: "blocked",
      summary: "Missing API key for provider; user must provide token.",
      details: { token: rawToken },
    });

    const text = fs.readFileSync(result.absolutePath, "utf8");
    expect(reasons.join("\n")).toContain("Owner approval");
    expect(text).toContain("Credential owner approval required: yes");
    expect(text).not.toContain(rawToken);
  });
});
