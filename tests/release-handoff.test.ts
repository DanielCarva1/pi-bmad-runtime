import { describe, expect, it } from "vitest";
import { buildV02ReleaseHandoffMatrix, formatReleaseHandoffMatrix, validateReleaseHandoffMatrix, type ReleaseHandoffMatrix } from "../extensions/bmad-runtime/release-handoff.js";

describe("release handoff matrix", () => {
  it("links v0.2 requirements to stories, tests and evidence without approving Phase 4", () => {
    const matrix = buildV02ReleaseHandoffMatrix("2026-06-09T00:00:00.000Z");
    const validation = validateReleaseHandoffMatrix(matrix);
    const formatted = formatReleaseHandoffMatrix(matrix);

    expect(validation.ok).toBe(true);
    expect(validation.readinessStatus).toBe("ready-for-readiness-check");
    expect(matrix.phase4Approved).toBe(false);
    expect(validation.coveredRequirements).toContain("FR52");
    expect(formatted).toContain("Phase 4 approved: false");
    expect(formatted).toContain("tests/smoke-resolution-workspace.test.ts");
    expect(formatted).toContain("_bmad-output/projects/pi-bmad-builder/evidence/story-7-4-dev-v0.2-2026-06-09.md");
  });

  it("blocks readiness when a requirement lacks test/evidence coverage and no waiver exists", () => {
    const matrix: ReleaseHandoffMatrix = {
      ...buildV02ReleaseHandoffMatrix(),
      readinessStatus: "blocked",
      entries: [
        {
          requirement: "FR999",
          description: "Missing coverage",
          stories: ["9.9"],
          tests: [],
          evidence: [],
        },
      ],
    };

    const validation = validateReleaseHandoffMatrix(matrix);

    expect(validation.ok).toBe(false);
    expect(validation.readinessStatus).toBe("blocked");
    expect(validation.failures.join("\n")).toContain("test and evidence coverage is required");
  });

  it("allows explicit waiver while keeping handoff out of Phase 4 approval", () => {
    const matrix: ReleaseHandoffMatrix = {
      ...buildV02ReleaseHandoffMatrix(),
      readinessStatus: "waiver-required",
      entries: [
        {
          requirement: "NFR-WAIVED",
          description: "Coverage deferred by Owner",
          stories: ["7.5"],
          tests: [],
          evidence: [],
          waiver: {
            owner: "Product Owner",
            reason: "Deferred to post-release monitoring",
            evidence: ["_bmad-output/projects/pi-bmad-builder/evidence/waiver.md"],
          },
        },
      ],
    };

    const validation = validateReleaseHandoffMatrix(matrix);

    expect(validation.ok).toBe(true);
    expect(validation.readinessStatus).toBe("waiver-required");
    expect(validation.waiverRequired).toEqual(["NFR-WAIVED"]);
    expect(matrix.phase4Approved).toBe(false);
  });

  it("rejects any handoff that attempts to approve Phase 4", () => {
    const matrix = buildV02ReleaseHandoffMatrix() as unknown as ReleaseHandoffMatrix & { phase4Approved: boolean };
    matrix.phase4Approved = true;
    matrix.readinessStatus = "blocked";

    const validation = validateReleaseHandoffMatrix(matrix as ReleaseHandoffMatrix);

    expect(validation.ok).toBe(false);
    expect(validation.failures).toContain("handoff must not approve Phase 4");
  });
});

