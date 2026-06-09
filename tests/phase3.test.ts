import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachPhase3ResumeState, buildPhase3AutomationPlan, buildPhase3ResumeState, validatePhase3ResumeState } from "../extensions/bmad-runtime/phase3.js";
import { createDefaultState } from "../extensions/bmad-runtime/state.js";

let tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-phase3-"));
  tempDirs.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function writeCompleteArtifact(root: string, file: string): void {
  writeFile(root, `_bmad-output/planning-artifacts/${file}`, `---\nstatus: complete\nworkflowType: test\n---\n# ${file}\n`);
}

function seedReadyArtifacts(root: string): void {
  for (const file of ["prd.md", "ux-design-specification.md", "phase-2-grill-with-docs-2026-05-29.md", "architecture.md", "epics.md"]) {
    writeCompleteArtifact(root, file);
  }
  writeFile(root, "_bmad-output/planning-artifacts/implementation-readiness-report-2026-05-29.md", "---\nreadinessDecision: pass\n---\n# Report\n**Overall Status:** READY\n");
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("Phase 3 resume state", () => {
  it("resumes from epics/stories when architecture exists and epics are missing", () => {
    const root = makeRoot();
    writeCompleteArtifact(root, "architecture.md");
    const state = { ...createDefaultState(), active: true, mode: "autonomous" as const, track: "bmad-method" as const, phase: "3-solutioning" as const };

    const snapshot = buildPhase3ResumeState(root, state, new Date("2026-06-09T00:00:00.000Z"));
    const validation = validatePhase3ResumeState(root, snapshot);

    expect(snapshot.workflowId).toBe("bmad-create-epics-and-stories");
    expect(snapshot.currentStep).toBe("epics-stories");
    expect(snapshot.artifactPaths.architecture).toBe("_bmad-output/planning-artifacts/architecture.md");
    expect(snapshot.artifactStatuses.architecture).toBe("canonical");
    expect(snapshot.artifactStatuses.epics).toBe("missing");
    expect(snapshot.gateStatus).toBe("blocked");
    expect(snapshot.resumeAction).toContain("bmad-create-epics-and-stories");
    expect(validation.ok).toBe(true);
    expect(validation.writeOccurred).toBe(false);
  });

  it("marks Phase 3 ready only when architecture, epics, and readiness are parseable and passed", () => {
    const root = makeRoot();
    seedReadyArtifacts(root);
    const state = { ...createDefaultState(), active: true, mode: "autonomous" as const, track: "bmad-method" as const, phase: "3-solutioning" as const, currentWorkflow: "bmad-check-implementation-readiness" };

    const snapshot = buildPhase3ResumeState(root, state, new Date("2026-06-09T00:00:00.000Z"));
    const validation = validatePhase3ResumeState(root, snapshot);

    expect(snapshot.workflowId).toBe("bmad-check-implementation-readiness");
    expect(snapshot.currentStep).toBe("ready-for-phase-4");
    expect(snapshot.gateStatus).toBe("ready");
    expect(snapshot.validationReportPaths).toContain("_bmad-output/planning-artifacts/implementation-readiness-report-2026-05-29.md");
    expect(validation.ok).toBe(true);
  });

  it("persists a compact Phase 3 snapshot when runtime state is Phase 3", () => {
    const root = makeRoot();
    seedReadyArtifacts(root);
    const state = { ...createDefaultState(), active: true, mode: "autonomous" as const, track: "bmad-method" as const, phase: "3-solutioning" as const };

    const next = attachPhase3ResumeState(root, state, new Date("2026-06-09T00:00:00.000Z"));

    expect(next.phase3?.currentStep).toBe("ready-for-phase-4");
    expect(next.phase3?.autonomyPolicyApplied).toBe(true);
    expect(Object.keys(next.phase3?.artifactPaths ?? {})).toEqual(["architecture", "epics", "readiness"]);
  });

  it("blocks Phase 3 automation plan before diff approval can hang the workflow", () => {
    const root = makeRoot();
    writeFile(root, ".pi/settings.json", JSON.stringify({ packages: ["pi-show-diffs"] }));
    const state = { ...createDefaultState(), active: true, mode: "autonomous" as const, track: "bmad-method" as const, phase: "3-solutioning" as const };

    const plan = buildPhase3AutomationPlan(root, state, new Date("2026-06-09T00:00:00.000Z"));

    expect(plan.completionGate).toBe("blocked");
    expect(plan.diffApproval.mode).toBe("unknown");
    expect(plan.prompt).toContain("mandatory prompt/modal");
    expect(plan.prompt).toContain("Do not execute this workflow");
    expect(plan.prompt).not.toContain("Execute this workflow with compact");
    expect(plan.validationChecks.join("\n")).toContain("diff approval policy");
  });
});
