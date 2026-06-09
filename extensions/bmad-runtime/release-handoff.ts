export type ReleaseHandoffReadinessStatus = "ready-for-readiness-check" | "blocked" | "waiver-required";

export interface ReleaseHandoffWaiver {
  owner: string;
  reason: string;
  evidence: string[];
}

export interface ReleaseHandoffMatrixEntry {
  requirement: string;
  description: string;
  stories: string[];
  tests: string[];
  evidence: string[];
  waiver?: ReleaseHandoffWaiver;
}

export interface ReleaseHandoffMatrix {
  release: string;
  generatedAt: string;
  phase4Approved: false;
  readinessStatus: ReleaseHandoffReadinessStatus;
  entries: ReleaseHandoffMatrixEntry[];
  notes: string[];
}

export interface ReleaseHandoffValidation {
  ok: boolean;
  readinessStatus: ReleaseHandoffReadinessStatus;
  failures: string[];
  waiverRequired: string[];
  coveredRequirements: string[];
}

function nonEmpty(value: string | undefined): boolean {
  return !!value && value.trim().length > 0;
}

function validWaiver(waiver: ReleaseHandoffWaiver | undefined): boolean {
  return !!waiver &&
    nonEmpty(waiver.owner) &&
    nonEmpty(waiver.reason) &&
    waiver.evidence.length > 0 &&
    waiver.evidence.every(nonEmpty);
}

export function validateReleaseHandoffMatrix(matrix: ReleaseHandoffMatrix): ReleaseHandoffValidation {
  const failures: string[] = [];
  const waiverRequired: string[] = [];
  const coveredRequirements: string[] = [];

  if (matrix.phase4Approved !== false) failures.push("handoff must not approve Phase 4");
  if (!nonEmpty(matrix.release)) failures.push("release is required");
  if (!nonEmpty(matrix.generatedAt) || Number.isNaN(Date.parse(matrix.generatedAt))) failures.push("generatedAt must be a valid timestamp");
  if (matrix.entries.length === 0) failures.push("handoff matrix requires at least one requirement entry");

  for (const entry of matrix.entries) {
    const label = entry.requirement || "unknown requirement";
    if (!nonEmpty(entry.requirement)) failures.push("requirement id is required");
    if (!nonEmpty(entry.description)) failures.push(`${label}: description is required`);
    const hasStories = entry.stories.length > 0 && entry.stories.every(nonEmpty);
    const hasTests = entry.tests.length > 0 && entry.tests.every(nonEmpty);
    const hasEvidence = entry.evidence.length > 0 && entry.evidence.every(nonEmpty);
    const waived = validWaiver(entry.waiver);
    if (!hasStories) failures.push(`${label}: story coverage is required`);
    if (!hasTests || !hasEvidence) {
      if (waived) waiverRequired.push(label);
      else failures.push(`${label}: test and evidence coverage is required unless an explicit waiver is recorded`);
    }
    if (hasStories && (hasTests || waived) && (hasEvidence || waived)) coveredRequirements.push(label);
  }

  const readinessStatus: ReleaseHandoffReadinessStatus =
    failures.length > 0 ? "blocked" : waiverRequired.length > 0 ? "waiver-required" : "ready-for-readiness-check";

  if (matrix.readinessStatus !== readinessStatus) {
    failures.push(`readinessStatus must be ${readinessStatus}, got ${matrix.readinessStatus}`);
  }

  return {
    ok: failures.length === 0,
    readinessStatus,
    failures,
    waiverRequired,
    coveredRequirements,
  };
}

export function buildV02ReleaseHandoffMatrix(generatedAt = "2026-06-09T00:00:00.000Z"): ReleaseHandoffMatrix {
  return {
    release: "pi-bmad-runtime v0.2 readiness handoff",
    generatedAt,
    phase4Approved: false,
    readinessStatus: "ready-for-readiness-check",
    notes: [
      "This handoff prepares bmad-check-implementation-readiness; it does not approve Phase 4.",
      "Every listed P0 requirement is linked to a story, test/smoke, and evidence path.",
      "External publication, remote writes, and release approval remain Owner/readiness decisions.",
    ],
    entries: [
      {
        requirement: "FR49",
        description: "Examples cover all start modes.",
        stories: ["7.1"],
        tests: ["tests/examples.test.ts"],
        evidence: ["_bmad-output/projects/pi-bmad-builder/evidence/story-7-1-dev-v0.2-2026-06-09.md"],
      },
      {
        requirement: "FR50",
        description: "Runtime migrates/reconciles v0.1.1 workspaces to v0.2 registry metadata without artifact loss.",
        stories: ["7.2"],
        tests: ["tests/migration.test.ts"],
        evidence: ["_bmad-output/projects/pi-bmad-builder/evidence/story-7-2-dev-v0.2-2026-06-09.md"],
      },
      {
        requirement: "FR51",
        description: "Registry schema is versioned and legacy schema migration is documented.",
        stories: ["1.1", "7.2"],
        tests: ["tests/registry.test.ts", "tests/migration.test.ts"],
        evidence: ["_bmad-output/projects/pi-bmad-builder/evidence/story-7-2-code-review-v0.2-2026-06-09.md"],
      },
      {
        requirement: "FR52",
        description: "P0 smoke/tests validate resolution, workspace, safety, gates, and release handoff coverage.",
        stories: ["7.3", "7.4", "7.5"],
        tests: ["tests/smoke-resolution-workspace.test.ts", "tests/smoke-safety-gates.test.ts", "tests/release-handoff.test.ts"],
        evidence: [
          "_bmad-output/projects/pi-bmad-builder/evidence/story-7-3-dev-v0.2-2026-06-09.md",
          "_bmad-output/projects/pi-bmad-builder/evidence/story-7-4-dev-v0.2-2026-06-09.md",
        ],
      },
      {
        requirement: "FR31/FR34/FR35/FR39/FR40",
        description: "Phase 3/4 control plane enforces readiness, completion evidence, review, retry and safety gates.",
        stories: ["4.1", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7", "7.4"],
        tests: ["tests/phase3.test.ts", "tests/phase4.test.ts", "tests/smoke-safety-gates.test.ts"],
        evidence: ["_bmad-output/projects/pi-bmad-builder/evidence/story-7-4-code-review-v0.2-2026-06-09.md"],
      },
      {
        requirement: "NFR5/NFR19",
        description: "Migration preserves artifacts, applies schemaVersion and records recovery evidence on failure.",
        stories: ["7.2"],
        tests: ["tests/migration.test.ts", "tests/registry.test.ts"],
        evidence: ["_bmad-output/projects/pi-bmad-builder/evidence/story-7-2-dev-v0.2-2026-06-09.md"],
      },
      {
        requirement: "NFR20/NFR21/NFR22",
        description: "Readiness handoff and Phase 3/4 evidence are traceable and cannot approve without checks/review/state.",
        stories: ["7.4", "7.5"],
        tests: ["tests/smoke-safety-gates.test.ts", "tests/release-handoff.test.ts"],
        evidence: ["_bmad-output/projects/pi-bmad-builder/evidence/story-7-4-dev-v0.2-2026-06-09.md"],
      },
      {
        requirement: "NFR23/NFR24",
        description: "Resolution/workspace smoke records confidence, evidence, bounds and duplicate-prevention behavior.",
        stories: ["7.3"],
        tests: ["tests/smoke-resolution-workspace.test.ts"],
        evidence: ["_bmad-output/projects/pi-bmad-builder/evidence/story-7-3-code-review-v0.2-2026-06-09.md"],
      },
    ],
  };
}

export function formatReleaseHandoffMatrix(matrix: ReleaseHandoffMatrix): string {
  const validation = validateReleaseHandoffMatrix(matrix);
  const lines = [
    `# ${matrix.release}`,
    "",
    `Generated at: ${matrix.generatedAt}`,
    `Readiness status: ${validation.readinessStatus}`,
    "Phase 4 approved: false",
    "",
    "## Notes",
    ...matrix.notes.map((note) => `- ${note}`),
    "",
    "## Matrix",
    "| Requirement | Stories | Tests | Evidence |",
    "|---|---|---|---|",
  ];
  for (const entry of matrix.entries) {
    lines.push(`| ${entry.requirement} | ${entry.stories.join(", ")} | ${entry.tests.join(", ")} | ${entry.evidence.join(", ")} |`);
  }
  if (validation.failures.length > 0) {
    lines.push("", "## Validation Failures", ...validation.failures.map((failure) => `- ${failure}`));
  }
  if (validation.waiverRequired.length > 0) {
    lines.push("", "## Waivers Required", ...validation.waiverRequired.map((requirement) => `- ${requirement}`));
  }
  return lines.join("\n");
}

