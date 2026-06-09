import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendPhase4RetryEvent, buildPhase4ResumeState, countPhase4RetryEvents, validatePhase4ResumeState } from "../extensions/bmad-runtime/phase4.js";
import { createDefaultState, saveState } from "../extensions/bmad-runtime/state.js";

let tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-phase4-"));
  tempDirs.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function writeSprint(root: string, storyKey: string, status: string): void {
  writeFile(root, "_bmad-output/implementation-artifacts/sprint-status.yaml", [
    "generated: 2026-06-09T00:00:00Z",
    "last_updated: 2026-06-09T00:00:00Z",
    "project: Test",
    "development_status:",
    "  epic-4: in-progress",
    `  ${storyKey}: ${status}`,
    "  epic-4-retrospective: optional",
    "",
  ].join("\n"));
}

function state() {
  return { ...createDefaultState(), active: true, mode: "autonomous" as const, track: "bmad-method" as const, phase: "4-implementation" as const };
}

function persistedState(root: string) {
  return saveState(root, state());
}

function doneStory(): string {
  return `# Story 4.3: Phase 4 resume

Status: done

## Acceptance Criteria

- Given story execution, When state is updated, Then it includes checkpoint evidence.

## Tasks / Subtasks

- [x] Implement resume.

## Senior Developer Review (AI)

**Outcome:** Approve. No unresolved findings remain.

## Dev Agent Record

### Debug Log References

- npm run typecheck - PASS.
- npm test - PASS.

### Completion Notes List

- Phase 4 resume complete.

### File List

- extensions/bmad-runtime/phase4.ts
- tests/phase4.test.ts
`;
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("Phase 4 resume state", () => {
  it("selects create-story for the next backlog story", () => {
    const root = makeRoot();
    writeSprint(root, "4-3-phase-4-state-resume-validate-para-story-execution", "backlog");

    const snapshot = buildPhase4ResumeState(root, persistedState(root), new Date("2026-06-09T00:00:00.000Z"));

    expect(snapshot.storyId).toBe("4-3-phase-4-state-resume-validate-para-story-execution");
    expect(snapshot.storyStatus).toBe("backlog");
    expect(snapshot.checkpoint).toBe("create-story");
    expect(snapshot.resumeAction).toContain("Create story context");
    expect(validatePhase4ResumeState(root, snapshot).ok).toBe(true);
  });

  it("recommends rerunning checks when implementation has changed files but no check evidence", () => {
    const root = makeRoot();
    const storyKey = "4-3-phase-4-state-resume-validate-para-story-execution";
    writeSprint(root, storyKey, "in-progress");
    writeFile(root, `_bmad-output/implementation-artifacts/${storyKey}.md`, `# Story

Status: in-progress

### File List

- extensions/bmad-runtime/phase4.ts
`);

    const snapshot = buildPhase4ResumeState(root, persistedState(root), new Date("2026-06-09T00:00:00.000Z"));

    expect(snapshot.checkpoint).toBe("run-checks");
    expect(snapshot.changedFilesSummary).toContain("extensions/bmad-runtime/phase4.ts");
    expect(snapshot.resumeAction).toContain("Rerun required checks");
  });

  it("blocks false completion when a done story lacks review and check evidence", () => {
    const root = makeRoot();
    const storyKey = "4-3-phase-4-state-resume-validate-para-story-execution";
    writeSprint(root, storyKey, "done");
    writeFile(root, `_bmad-output/implementation-artifacts/${storyKey}.md`, "# Story\n\nStatus: done\n");

    const snapshot = buildPhase4ResumeState(root, persistedState(root), new Date("2026-06-09T00:00:00.000Z"));
    const validation = validatePhase4ResumeState(root, snapshot);

    expect(snapshot.checkpoint).toBe("retry");
    expect(snapshot.failurePolicy.classification).toBe("retryable");
    expect(snapshot.blockerReason).toContain("missing acceptance criteria");
    expect(validation.ok).toBe(false);
    expect(validation.issues.join("\n")).toContain("review outcome");
  });

  it("schedules retry for a review story with failed check evidence", () => {
    const root = makeRoot();
    const storyKey = "4-6-retry-reopen-quando-review-check-ou-evidence-falha";
    writeSprint(root, storyKey, "review");
    writeFile(root, `_bmad-output/implementation-artifacts/${storyKey}.md`, `# Story 4.6: Retry/reopen policy

Status: review

## Acceptance Criteria

- Given a failed check, When classified as fixable, Then retry is scheduled.

## Dev Agent Record

### Debug Log References

- npm test - FAIL.

### File List

- extensions/bmad-runtime/phase4.ts
`);

    const snapshot = buildPhase4ResumeState(root, persistedState(root), new Date("2026-06-09T00:00:00.000Z"));

    expect(snapshot.checkpoint).toBe("retry");
    expect(snapshot.failurePolicy.classification).toBe("retryable");
    expect(snapshot.failurePolicy.retryScheduled).toBe(true);
    expect(snapshot.failurePolicy.retryTarget).toBe("retry");
    expect(snapshot.failurePolicy.retryRemaining).toBe(3);
    expect(snapshot.failurePolicy.reasons.join("\n")).toContain("Check failed");
    expect(validatePhase4ResumeState(root, snapshot).ok).toBe(true);
  });

  it("appends retry events with incrementing count while preserving history", () => {
    const first = appendPhase4RetryEvent(doneStory(), {
      reason: "Check failed: npm test",
      evidence: ["_bmad-output/evidence/story-4-6-dev.md"],
      now: new Date("2026-06-09T00:00:00.000Z"),
    });
    const second = appendPhase4RetryEvent(first.text, {
      actor: "BMAD Developer",
      reason: "Patch-required review finding",
      evidence: ["_bmad-output/evidence/story-4-6-code-review.md"],
      now: new Date("2026-06-09T01:00:00.000Z"),
    });

    expect(first.retryCount).toBe(1);
    expect(second.retryCount).toBe(2);
    expect(countPhase4RetryEvents(second.text)).toBe(2);
    expect(second.text).toContain("retry attempt 1");
    expect(second.text).toContain("retry attempt 2");
    expect(second.text).toContain("Patch-required review finding");
  });

  it("blocks when retry limit is reached", () => {
    const root = makeRoot();
    const storyKey = "4-6-retry-reopen-quando-review-check-ou-evidence-falha";
    writeSprint(root, storyKey, "review");
    const withRetries = [
      "# Story 4.6",
      "",
      "Status: review",
      "",
      "## Acceptance Criteria",
      "",
      "- Given retry limit, When exceeded, Then blocked.",
      "",
      "## Retry History",
      "",
      "- retry attempt 1; reopened at: 2026-06-09T00:00:00.000Z; reason: failed check",
      "- retry attempt 2; reopened at: 2026-06-09T01:00:00.000Z; reason: failed check",
      "- retry attempt 3; reopened at: 2026-06-09T02:00:00.000Z; reason: failed check",
      "",
      "## Dev Agent Record",
      "",
      "### Debug Log References",
      "",
      "- npm test - FAIL.",
      "",
      "### File List",
      "",
      "- extensions/bmad-runtime/phase4.ts",
      "",
    ].join("\n");
    writeFile(root, `_bmad-output/implementation-artifacts/${storyKey}.md`, withRetries);

    const snapshot = buildPhase4ResumeState(root, persistedState(root), new Date("2026-06-09T00:00:00.000Z"));

    expect(snapshot.checkpoint).toBe("blocked");
    expect(snapshot.failurePolicy.classification).toBe("blocked");
    expect(snapshot.failurePolicy.retryRemaining).toBe(0);
    expect(snapshot.failurePolicy.reasons.join("\n")).toContain("Retry limit 3 reached");
  });

  it("blocks done when patch-required review findings remain unresolved", () => {
    const root = makeRoot();
    const storyKey = "4-6-retry-reopen-quando-review-check-ou-evidence-falha";
    writeSprint(root, storyKey, "done");
    writeFile(root, `_bmad-output/implementation-artifacts/${storyKey}.md`, `${doneStory()}

- [patch-required] Fix retry evidence gap before completion.
`);
    writeFile(root, "_bmad-output/evidence/story-4-6-code-review.md", "# Evidence\n");

    const snapshot = buildPhase4ResumeState(root, persistedState(root), new Date("2026-06-09T00:00:00.000Z"));
    const validation = validatePhase4ResumeState(root, snapshot);

    expect(snapshot.checkpoint).toBe("retry");
    expect(snapshot.failurePolicy.classification).toBe("retryable");
    expect(snapshot.blockerReason).toContain("Patch required");
    expect(validation.ok).toBe(false);
    expect(validation.issues.join("\n")).toContain("failure policy is retryable");
  });

  it("records accepted risk only when Owner, scope and evidence are explicit", () => {
    const root = makeRoot();
    const storyKey = "4-6-retry-reopen-quando-review-check-ou-evidence-falha";
    writeSprint(root, storyKey, "done");
    writeFile(root, `_bmad-output/implementation-artifacts/${storyKey}.md`, `# Story 4.6: Accepted Risk

Status: done

## Acceptance Criteria

- Given residual risk, When the Owner approves it, Then accepted risk is recorded with scope and evidence.

## Tasks / Subtasks

- [x] Record approved residual risk.

## Senior Developer Review (AI)

**Outcome:** Approve. No unresolved findings remain.

- [accepted-risk] Owner: Product Owner; Scope: known external-package dry-run warning; Evidence: _bmad-output/evidence/story-4-6-risk.md

## Dev Agent Record

### Debug Log References

- npm run typecheck - PASS.
- npm test - PASS.

### Completion Notes List

- Accepted risk recorded with owner, scope and evidence.

### File List

- extensions/bmad-runtime/phase4.ts
`);
    writeFile(root, "_bmad-output/evidence/story-4-6-risk.md", "# Accepted risk evidence\n");

    const snapshot = buildPhase4ResumeState(root, persistedState(root), new Date("2026-06-09T00:00:00.000Z"));
    const validation = validatePhase4ResumeState(root, snapshot);

    expect(snapshot.checkpoint).toBe("complete");
    expect(snapshot.failurePolicy.classification).toBe("none");
    expect(snapshot.failurePolicy.acceptedRisk?.owner).toBe("Product Owner");
    expect(snapshot.failurePolicy.acceptedRisk?.scope).toBe("known external-package dry-run warning");
    expect(snapshot.failurePolicy.acceptedRisk?.evidence).toContain("_bmad-output/evidence/story-4-6-risk.md");
    expect(validation.ok).toBe(true);
  });

  it("marks a done story complete when story, checks, review and evidence are present", () => {
    const root = makeRoot();
    const storyKey = "4-3-phase-4-state-resume-validate-para-story-execution";
    writeSprint(root, storyKey, "done");
    writeFile(root, `_bmad-output/implementation-artifacts/${storyKey}.md`, doneStory());
    writeFile(root, "_bmad-output/evidence/story-4-3-code-review.md", "# Evidence\n");

    const snapshot = buildPhase4ResumeState(root, persistedState(root), new Date("2026-06-09T00:00:00.000Z"));
    const validation = validatePhase4ResumeState(root, snapshot);

    expect(snapshot.checkpoint).toBe("complete");
    expect(snapshot.reviewOutcome).toBe("approved");
    expect(snapshot.checks.some((check) => check.result === "pass")).toBe(true);
    expect(snapshot.completionEvidence).toContain("_bmad-output/evidence/story-4-3-code-review.md");
    expect(snapshot.completionEvidence).toContain("timestamp: sprint-status.last_updated");
    expect(snapshot.completionEvidence).toContain("state: .bmad-runtime/state.json");
    expect(validation.ok).toBe(true);
  });

  it("blocks done when an explicit project-owned evidence path is missing", () => {
    const root = makeRoot();
    const storyKey = "4-3-phase-4-state-resume-validate-para-story-execution";
    writeSprint(root, storyKey, "done");
    writeFile(root, `_bmad-output/implementation-artifacts/${storyKey}.md`, `${doneStory()}

Evidence: _bmad-output/evidence/story-4-3-missing-review.md
`);

    const snapshot = buildPhase4ResumeState(root, state(), new Date("2026-06-09T00:00:00.000Z"));
    const validation = validatePhase4ResumeState(root, snapshot);

    expect(snapshot.checkpoint).toBe("retry");
    expect(snapshot.failurePolicy.classification).toBe("retryable");
    expect(snapshot.failurePolicy.reasons.join("\n")).toContain("Project-owned artifact/evidence path does not exist");
    expect(validation.ok).toBe(false);
  });

  it("blocks done when runtime state update is not persisted", () => {
    const root = makeRoot();
    const storyKey = "4-3-phase-4-state-resume-validate-para-story-execution";
    writeSprint(root, storyKey, "done");
    writeFile(root, `_bmad-output/implementation-artifacts/${storyKey}.md`, doneStory());
    writeFile(root, "_bmad-output/evidence/story-4-3-code-review.md", "# Evidence\n");

    const snapshot = buildPhase4ResumeState(root, state(), new Date("2026-06-09T00:00:00.000Z"));

    expect(snapshot.checkpoint).toBe("retry");
    expect(snapshot.failurePolicy.reasons.join("\n")).toContain("No persisted runtime state update recorded");
  });
});
