import { describe, expect, it } from "vitest";
import {
  classifyArtifactCleanupPath,
  formatArtifactCleanupPolicy,
  isEphemeralTaskPacketPath,
  isProtectedCanonicalArtifactPath,
} from "../extensions/bmad-runtime/artifacts.js";

describe("artifact cleanup policy", () => {
  it("blocks canonical artifacts from ephemeral cleanup", () => {
    for (const artifactPath of [
      ".bmad-runtime/state.json",
      ".bmad-runtime/handoffs/latest-handoff.md",
      "_bmad-output/planning-artifacts/prd.md",
      "_bmad-output/implementation-artifacts/sprint-status.yaml",
      "_bmad-output/implementation-artifacts/1-1-first-story.md",
      "_bmad-output/evidence/story-1-1-dev.md",
    ]) {
      expect(isProtectedCanonicalArtifactPath(artifactPath)).toBe(true);
      const result = classifyArtifactCleanupPath(artifactPath, {
        resultCaptured: true,
        changedFilesListed: true,
        checksRecorded: true,
        evidenceReferenced: true,
        nextStatusUpdated: true,
      });
      expect(result.decision).toBe("protected-canonical");
      expect(result.canDeleteOrArchive).toBe(false);
    }
  });

  it("allows task-packet cleanup only after completion evidence is captured", () => {
    const blocked = classifyArtifactCleanupPath("_bmad-output/task-packets/story-1-1-agent-brief.md", {
      resultCaptured: true,
      changedFilesListed: true,
    });
    expect(isEphemeralTaskPacketPath(blocked.path)).toBe(true);
    expect(blocked.decision).toBe("ephemeral-candidate-blocked");
    expect(blocked.canDeleteOrArchive).toBe(false);
    expect(blocked.missingEvidence).toEqual(["checks recorded", "evidence referenced", "next status updated"]);

    const allowed = classifyArtifactCleanupPath("docs/task-packets/story-1-1-agent-brief.md", {
      resultCaptured: true,
      changedFilesListed: true,
      checksRecorded: true,
      evidenceReferenced: true,
      nextStatusUpdated: true,
    });
    expect(allowed.decision).toBe("ephemeral-candidate-allowed");
    expect(allowed.canDeleteOrArchive).toBe(true);
  });

  it("blocks unknown paths and documents the cleanup guard", () => {
    const unknown = classifyArtifactCleanupPath("docs/random-note.md", {
      resultCaptured: true,
      changedFilesListed: true,
      checksRecorded: true,
      evidenceReferenced: true,
      nextStatusUpdated: true,
    });
    expect(unknown.decision).toBe("unmanaged-blocked");
    expect(unknown.canDeleteOrArchive).toBe(false);
    expect(formatArtifactCleanupPolicy()).toContain("Protected canonical artifacts are never task-packet cleanup targets");
  });
});
