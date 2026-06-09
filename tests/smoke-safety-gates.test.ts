import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateDiffApprovalPolicy } from "../extensions/bmad-runtime/diff-approval.js";
import { shouldBlockDangerousToolCall, shouldBlockWriteForAmbiguousResolution } from "../extensions/bmad-runtime/gates.js";
import { buildPhase3ResumeState, validatePhase3ResumeState } from "../extensions/bmad-runtime/phase3.js";
import { buildPhase4ResumeState, validatePhase4ResumeState } from "../extensions/bmad-runtime/phase4.js";
import {
  formatSafetyGateSmokeReport,
  validateSafetyGateSmokeResults,
  type SafetyGateSmokeResult,
} from "../extensions/bmad-runtime/smoke.js";
import { createDefaultState, getStateFile, saveState, type RuntimeState } from "../extensions/bmad-runtime/state.js";

let tempDirs: string[] = [];

function makeRoot(prefix = "pi-bmad-safety-smoke-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function writeCompleteArtifact(root: string, file: string): void {
  writeFile(root, `_bmad-output/planning-artifacts/${file}`, `---\nstatus: complete\nworkflowType: test\n---\n# ${file}\nFR31 NFR21 dependencies covered.\n`);
}

function seedReadyPhase3(root: string): void {
  for (const file of ["prd.md", "ux-design-specification.md", "phase-2-grill-with-docs-2026-05-29.md", "architecture.md", "epics.md"]) {
    writeCompleteArtifact(root, file);
  }
  writeFile(root, "_bmad-output/planning-artifacts/implementation-readiness-report-2026-05-29.md", "---\nreadinessDecision: pass\n---\n# Report\n**Overall Status:** READY\n");
}

function writeSprint(root: string, storyKey: string, status: string): void {
  writeFile(root, "_bmad-output/implementation-artifacts/sprint-status.yaml", [
    "generated: 2026-06-09T00:00:00.000Z",
    "last_updated: 2026-06-09T00:00:00.000Z",
    "project: Test",
    "development_status:",
    "  epic-4: in-progress",
    `  ${storyKey}: ${status}`,
    "  epic-4-retrospective: optional",
    "",
  ].join("\n"));
}

function doneStory(): string {
  return `# Story 4.3: Phase 4 state resume validate

Status: done

## Acceptance Criteria

- Given a Phase 4 story, When completion is evaluated, Then artifact, checks, review and state evidence are present.

## Tasks / Subtasks

- [x] Implement story.

## Dev Agent Record

### Debug Log References

- npm run typecheck - PASS.
- npm test - PASS.

### Completion Notes List

- Completion evidence persisted.

### File List

- extensions/bmad-runtime/phase4.ts

## Senior Developer Review (AI)

**Outcome:** Approve. No unresolved findings remain.
`;
}

function persistedState(root: string, phase: RuntimeState["phase"], currentWorkflow: string, currentStory?: string): RuntimeState {
  return saveState(root, {
    ...createDefaultState(),
    active: true,
    mode: "autonomous",
    track: "bmad-method",
    phase,
    currentWorkflow,
    currentStory,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("P0 safety, gates and Phase 3/4 control-plane smoke suite", () => {
  it("rejects duplicate safety scenario records in the smoke contract", () => {
    const base: SafetyGateSmokeResult = {
      scenario: "boundary-write-block",
      expectedResult: "block",
      evidenceUsed: ["writeOccurred: false"],
      blocked: true,
      writeOccurred: false,
    };
    const validation = validateSafetyGateSmokeResults([
      base,
      { ...base },
      { ...base, scenario: "ambiguous-identity-write-block" },
      {
        ...base,
        scenario: "phase3-readiness-gate",
        artifactPath: "_bmad-output/planning-artifacts/readiness.md",
        validationResult: "pass",
        gateOutcome: "ready",
        timestamp: "2026-06-09T00:00:00.000Z",
        stateUpdatePersisted: true,
      },
      {
        ...base,
        scenario: "phase4-completion-gate",
        artifactPath: "_bmad-output/implementation-artifacts/story.md",
        checkResult: "pass",
        validationResult: "pass",
        reviewOutcome: "approved",
        gateOutcome: "complete",
        timestamp: "2026-06-09T00:00:00.000Z",
        stateUpdatePersisted: true,
      },
      { ...base, scenario: "diff-approval-policy", diffApprovalMode: "bypass", blocked: false },
    ]);

    expect(validation.ok).toBe(false);
    expect(validation.failures).toContain("boundary-write-block: duplicate scenario result");
  });

  it("executes safety and gate scenarios with persisted evidence fields", () => {
    const results: SafetyGateSmokeResult[] = [];
    const builderLikeCwd = path.join(path.dirname(process.cwd()), "pi-bmad-builder");

    {
      const state = { ...createDefaultState(), active: true, phase: "3-solutioning" as const, mode: "autonomous" as const };
      const blocked = shouldBlockDangerousToolCall(state, builderLikeCwd, "bash", {
        command: "touch ../pi-bmad-runtime/extensions/bmad-runtime/index.ts",
      });
      results.push({
        scenario: "boundary-write-block",
        expectedResult: "block Phase 3 mutation targeting the runtime package",
        evidenceUsed: [blocked ?? ""].filter(Boolean),
        blocked: !!blocked,
        writeOccurred: false,
        validationResult: blocked ? "blocked" : "fail",
      });
      expect(blocked).toContain("Target Code Repo");
      expect(blocked).toContain("writeOccurred: false");
    }

    {
      const blocked = shouldBlockWriteForAmbiguousResolution("ambiguous", "write", { path: "README.md" }, "multiple matching projects", {
        nextSafeAction: "choose the project explicitly",
        recoveryAction: "show-project-picker",
      });
      results.push({
        scenario: "ambiguous-identity-write-block",
        expectedResult: "block writes until project identity is selected",
        evidenceUsed: [blocked ?? ""].filter(Boolean),
        blocked: !!blocked,
        writeOccurred: false,
        validationResult: blocked ? "blocked" : "fail",
      });
      expect(blocked).toContain("active-project-resolution");
      expect(blocked).toContain("writeOccurred: false");
    }

    {
      const root = makeRoot();
      seedReadyPhase3(root);
      const state = persistedState(root, "3-solutioning", "bmad-check-implementation-readiness");
      const snapshot = buildPhase3ResumeState(root, state, new Date("2026-06-09T00:00:00.000Z"));
      const validation = validatePhase3ResumeState(root, snapshot);
      results.push({
        scenario: "phase3-readiness-gate",
        expectedResult: "Phase 3 reaches ready-for-phase-4 only with readiness artifact and persisted state",
        evidenceUsed: [...snapshot.validationReportPaths, `state:${getStateFile(root)}`],
        blocked: !validation.ok,
        writeOccurred: validation.writeOccurred,
        artifactPath: snapshot.artifactPaths.readiness,
        validationResult: validation.ok ? "pass" : "fail",
        gateOutcome: snapshot.gateStatus,
        timestamp: snapshot.updatedAt,
        stateUpdatePersisted: fs.existsSync(getStateFile(root)),
      });
      expect(snapshot.currentStep).toBe("ready-for-phase-4");
      expect(validation.ok).toBe(true);
    }

    {
      const root = makeRoot();
      const storyKey = "4-3-phase-4-state-resume-validate-para-story-execution";
      writeSprint(root, storyKey, "done");
      writeFile(root, `_bmad-output/implementation-artifacts/${storyKey}.md`, doneStory());
      writeFile(root, "_bmad-output/evidence/story-4-3-code-review.md", "# Evidence\n");
      const state = persistedState(root, "4-implementation", "bmad-code-review", "4.3");
      const snapshot = buildPhase4ResumeState(root, state, new Date("2026-06-09T00:00:00.000Z"));
      const validation = validatePhase4ResumeState(root, snapshot);
      results.push({
        scenario: "phase4-completion-gate",
        expectedResult: "Phase 4 complete requires story artifact, passing check, approved review, timestamp and state evidence",
        evidenceUsed: snapshot.completionEvidence,
        blocked: !validation.ok,
        writeOccurred: validation.writeOccurred,
        artifactPath: snapshot.storyPath,
        checkResult: snapshot.checks.some((check) => check.result === "pass") ? "pass" : "fail",
        validationResult: validation.ok ? "pass" : "fail",
        reviewOutcome: snapshot.reviewOutcome,
        gateOutcome: snapshot.checkpoint,
        timestamp: snapshot.updatedAt,
        stateUpdatePersisted: snapshot.completionEvidence.some((item) => item.startsWith("state:")),
      });
      expect(snapshot.checkpoint).toBe("complete");
      expect(validation.ok).toBe(true);
    }

    {
      const root = makeRoot();
      writeFile(root, ".pi/settings.json", JSON.stringify({ packages: [{ source: "pi-show-diffs", autoApprove: true }] }, null, 2));
      const policy = evaluateDiffApprovalPolicy(root);
      results.push({
        scenario: "diff-approval-policy",
        expectedResult: "diff approval is installed in bypass mode and does not block automation",
        evidenceUsed: policy.evidence,
        blocked: policy.blocking,
        writeOccurred: false,
        validationResult: policy.blocking ? "blocked" : "pass",
        diffApprovalMode: policy.mode,
        blockerBeforeLoop: policy.blocking,
      });
      expect(policy.mode).toBe("bypass");
      expect(policy.blocking).toBe(false);
    }

    const validation = validateSafetyGateSmokeResults(results);
    const report = formatSafetyGateSmokeReport(results);

    expect(validation.ok).toBe(true);
    expect(report).toContain("Safety smoke suite: pass");
    expect(report).toContain("boundary-write-block");
    expect(report).toContain("phase4-completion-gate");
    expect(report).toContain("Diff approval mode: bypass");
  });
});
