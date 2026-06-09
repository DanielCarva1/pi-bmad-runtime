import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { shouldBlockDangerousToolCall, shouldBlockMutationInPlanning, shouldBlockSprintStatusMutation, shouldBlockStoryDoneMutation, shouldBlockWriteForAmbiguousResolution } from "../extensions/bmad-runtime/gates.js";
import { createDefaultState } from "../extensions/bmad-runtime/state.js";

const cwd = process.cwd();
const builderLikeCwd = path.join(path.dirname(cwd), "pi-bmad-builder");

describe("planning mutation gate", () => {
  it("blocks source edits during interview planning", () => {
    const state = { ...createDefaultState(), active: true, phase: "2-planning" as const, mode: "interview" as const };
    const reason = shouldBlockMutationInPlanning(state, cwd, "edit", { path: "src/app.ts" });
    expect(reason).toContain("planning gate blocked");
  });

  it("allows BMAD artifact edits during planning", () => {
    const state = { ...createDefaultState(), active: true, phase: "2-planning" as const, mode: "interview" as const };
    const reason = shouldBlockMutationInPlanning(state, cwd, "write", { path: "_bmad-output/planning-artifacts/prd.md" });
    expect(reason).toBeUndefined();
  });

  it("allows source edits during implementation", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    const reason = shouldBlockMutationInPlanning(state, cwd, "edit", { path: "src/app.ts" });
    expect(reason).toBeUndefined();
  });

  it("blocks Phase 3 writes to the Target Code Repo", () => {
    const state = { ...createDefaultState(), active: true, phase: "3-solutioning" as const, mode: "autonomous" as const };
    const reason = shouldBlockMutationInPlanning(state, builderLikeCwd, "write", {
      path: "../pi-bmad-runtime/extensions/bmad-runtime/index.ts",
    });
    expect(reason).toContain("Target Code Repo");
    expect(reason).toContain("writeOccurred: false");
  });

  it("allows Phase 3 read-only access to the Target Code Repo", () => {
    const state = { ...createDefaultState(), active: true, phase: "3-solutioning" as const, mode: "autonomous" as const };
    const reason = shouldBlockMutationInPlanning(state, builderLikeCwd, "read", {
      path: "../pi-bmad-runtime/extensions/bmad-runtime/index.ts",
    });
    expect(reason).toBeUndefined();
  });

  it("does not apply the Phase 3 Target Code Repo boundary during Phase 4", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    const reason = shouldBlockMutationInPlanning(state, builderLikeCwd, "write", {
      path: "../pi-bmad-runtime/extensions/bmad-runtime/index.ts",
    });
    expect(reason).toBeUndefined();
  });
});

describe("sprint status gate", () => {
  it("blocks illegal direct story transition to done", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    const reason = shouldBlockSprintStatusMutation(state, cwd, "edit", {
      path: "_bmad-output/implementation-artifacts/sprint-status.yaml",
      edits: [
        {
          oldText: "  1-1-test: ready-for-dev\n",
          newText: "  1-1-test: done\n",
        },
      ],
    });
    expect(reason).toContain("Illegal story transition");
  });

  it("allows legal story transition into progress", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    const reason = shouldBlockSprintStatusMutation(state, cwd, "edit", {
      path: "_bmad-output/implementation-artifacts/sprint-status.yaml",
      edits: [
        {
          oldText: "  1-1-test: ready-for-dev\n",
          newText: "  1-1-test: in-progress\n",
        },
      ],
    });
    expect(reason).toBeUndefined();
  });

  it("blocks invalid full sprint-status writes", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    const reason = shouldBlockSprintStatusMutation(state, cwd, "write", {
      path: "_bmad-output/implementation-artifacts/sprint-status.yaml",
      content: "development_status:\n  1-1-test: shipped\n",
    });
    expect(reason).toContain("Illegal story status");
  });
});

describe("dangerous action gate", () => {
  it("blocks publish and destructive shell commands", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    expect(shouldBlockDangerousToolCall(state, cwd, "bash", { command: "npm publish" })).toContain("external-publication gate");
    expect(shouldBlockDangerousToolCall(state, cwd, "bash", { command: "rm -rf /tmp/example" })).toContain("safety gate blocked");
    expect(shouldBlockDangerousToolCall(state, cwd, "bash", { command: "rm -rf /tmp/example" })).toContain("writeOccurred: false");
  });

  it("blocks remote, push, GitHub creation and deploy publication without owner approval", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    const remote = shouldBlockDangerousToolCall(state, cwd, "bash", { command: "git remote add origin git@github.com:acme/app.git" });
    expect(remote).toContain("external-publication gate");
    expect(remote).toContain("Owner approval required");
    expect(remote).toContain("writeOccurred: false");
    expect(shouldBlockDangerousToolCall(state, cwd, "bash", { command: "git push origin main" })).toContain("git push");
    expect(shouldBlockDangerousToolCall(state, cwd, "bash", { command: "gh repo create acme/app --private" })).toContain("GitHub repository creation");
    expect(shouldBlockDangerousToolCall(state, cwd, "vercel", { action: "deploy", target: "production" })).toContain("deploy/publication");
  });

  it("blocks credentials and paid service operations without Owner approval", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    const credential = shouldBlockDangerousToolCall(state, cwd, "bash", { command: "export OPENAI_API_KEY=sk-test" });
    expect(credential).toContain("prompt policy");
    expect(credential).toContain("Policy action: credentials");
    expect(credential).toContain("Owner approval required");
    expect(credential).toContain("writeOccurred: false");

    const paid = shouldBlockDangerousToolCall(state, cwd, "bash", { command: "stripe products create --name Pro" });
    expect(paid).toContain("Policy action: paid-service");
    expect(paid).toContain("Owner approval required");
    expect(paid).toContain("Evidence required");
  });

  it("blocks mutating shell commands targeting the Target Code Repo in Phase 3", () => {
    const state = { ...createDefaultState(), active: true, phase: "3-solutioning" as const, mode: "autonomous" as const };
    expect(
      shouldBlockDangerousToolCall(state, cwd, "bash", {
        command: "touch ../pi-bmad-runtime/extensions/bmad-runtime/index.ts",
      }),
    ).toContain("Target Code Repo");
    expect(
      shouldBlockDangerousToolCall(state, cwd, "bash", {
        command: "cd ../pi-bmad-runtime && touch extensions/bmad-runtime/index.ts",
      }),
    ).toContain("Target Code Repo");
    expect(
      shouldBlockDangerousToolCall(state, cwd, "bash", {
        command: "git -C '../pi-bmad-runtime' add extensions/bmad-runtime/index.ts",
      }),
    ).toContain("Target Code Repo");
    expect(
      shouldBlockDangerousToolCall(state, cwd, "bash", {
        command: "npm --prefix ../pi-bmad-runtime run build",
      }),
    ).toContain("Target Code Repo");
    expect(
      shouldBlockDangerousToolCall(state, cwd, "apply_patch", {
        patch: "*** Begin Patch\n*** Update File: ../pi-bmad-runtime/extensions/bmad-runtime/index.ts\n*** End Patch",
      }),
    ).toContain("Target Code Repo");
    expect(
      shouldBlockDangerousToolCall(state, cwd, "bash", {
        command: "echo x > ../pi-bmad-runtime/extensions/bmad-runtime/index.ts",
      }),
    ).toContain("Target Code Repo");
    expect(
      shouldBlockDangerousToolCall(state, cwd, "bash", {
        command: "git add README.md",
      }),
    ).toBeUndefined();
    expect(
      shouldBlockDangerousToolCall(state, cwd, "bash", {
        command: "npm test --prefix ../pi-bmad-runtime",
      }),
    ).toBeUndefined();
  });
});

describe("active project ambiguity write gate", () => {
  it("blocks write/edit/apply_patch and mutating shell commands for unsafe resolution", () => {
    expect(shouldBlockWriteForAmbiguousResolution("ambiguous", "write", { path: "README.md" })).toContain("writeOccurred: false");
    expect(shouldBlockWriteForAmbiguousResolution("blocked", "write", { path: "README.md" })).toContain("Confidence: blocked");
    expect(shouldBlockWriteForAmbiguousResolution("new_project_intent_required", "write", { path: "README.md" })).toContain("new_project_intent_required");
    expect(shouldBlockWriteForAmbiguousResolution("local_workspace_unregistered", "write", { path: "README.md" })).toContain("local_workspace_unregistered");
    expect(shouldBlockWriteForAmbiguousResolution("needs_rebind", "write", { path: "README.md" })).toContain("needs_rebind");
    expect(shouldBlockWriteForAmbiguousResolution("variant_choice_required", "write", { path: "README.md" })).toContain("variant_choice_required");
    expect(shouldBlockWriteForAmbiguousResolution("ambiguous", "edit", { path: "README.md" })).toContain("explicitly");
    expect(shouldBlockWriteForAmbiguousResolution("ambiguous", "apply_patch", { input: "*** Begin Patch" })).toContain("variant choice");
    expect(shouldBlockWriteForAmbiguousResolution("ambiguous", "bash", { command: "touch README.md" })).toContain("active-project-resolution");
    expect(shouldBlockWriteForAmbiguousResolution("ambiguous", "bash", { command: "node -e 'require(\"fs\").writeFileSync(\"x\",\"y\")'" })).toContain("active-project-resolution");
    expect(shouldBlockWriteForAmbiguousResolution("ambiguous", "bash", { command: "echo x>README.md" })).toContain("active-project-resolution");
  });

  it("includes cause, action, path or command, write flag and next safe action in write blockers", () => {
    const write = shouldBlockWriteForAmbiguousResolution("needs_rebind", "write", { path: "README.md" }, "registry paths point elsewhere", {
      cwd,
      nextSafeAction: "confirm workspace rebind before retrying",
      recoveryAction: "confirm-workspace-rebind",
    });

    expect(write).toContain("Cause: registry paths point elsewhere");
    expect(write).toContain("Confidence: needs_rebind; writeOccurred: false.");
    expect(write).toContain("Action: write");
    expect(write).toContain("Path: README.md");
    expect(write).toContain("Next safe action: confirm workspace rebind before retrying");
    expect(write).toContain("Recovery: confirm-workspace-rebind");

    const patch = shouldBlockWriteForAmbiguousResolution("ambiguous", "apply_patch", {
      patch: "*** Begin Patch\n*** Update File: extensions/bmad-runtime/index.ts\n*** End Patch",
    }, "multiple candidates", { nextSafeAction: "choose the project explicitly" });
    expect(patch).toContain("Action: apply_patch");
    expect(patch).toContain("Path: extensions/bmad-runtime/index.ts");

    const bash = shouldBlockWriteForAmbiguousResolution("blocked", "bash", { command: "touch README.md" }, "identity conflict");
    expect(bash).toContain("Action: bash mutation");
    expect(bash).toContain("Command: touch README.md");
  });

  it("allows read-only or unique-confidence operations", () => {
    expect(shouldBlockWriteForAmbiguousResolution("unique_confident", "write", { path: "README.md" })).toBeUndefined();
    expect(shouldBlockWriteForAmbiguousResolution("ambiguous", "read", { path: "README.md" })).toBeUndefined();
    expect(shouldBlockWriteForAmbiguousResolution("ambiguous", "bash", { command: "npm test" })).toBeUndefined();
  });

  it("does not bypass boundary or story gates when active project is unique_confident", () => {
    const phase3 = { ...createDefaultState(), active: true, phase: "3-solutioning" as const, mode: "autonomous" as const };
    const phase4 = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };

    expect(shouldBlockWriteForAmbiguousResolution("unique_confident", "write", { path: "../pi-bmad-runtime/extensions/bmad-runtime/index.ts" })).toBeUndefined();
    expect(shouldBlockDangerousToolCall(phase3, builderLikeCwd, "write", { path: "../pi-bmad-runtime/extensions/bmad-runtime/index.ts" })).toContain("Target Code Repo");
    expect(shouldBlockStoryDoneMutation(phase4, cwd, "write", {
      path: "_bmad-output/implementation-artifacts/1-1-test-story.md",
      content: "# Story\n\nStatus: done\n",
    })).toContain("premature done");
  });
});

describe("story done gate", () => {
  it("blocks full story writes that mark incomplete stories done", () => {
    const state = { ...createDefaultState(), active: true, phase: "4-implementation" as const, mode: "autonomous" as const };
    const reason = shouldBlockStoryDoneMutation(state, cwd, "write", {
      path: "_bmad-output/implementation-artifacts/1-1-test-story.md",
      content: `# Story 1.1: Test\n\nStatus: done\n\n## Tasks / Subtasks\n\n- [ ] Finish\n\n## Dev Agent Record\n\n### File List\n`,
    });
    expect(reason).toContain("premature done");
  });
});
