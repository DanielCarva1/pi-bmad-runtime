import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProjectInitialized } from "../extensions/bmad-runtime/project.js";
import {
  REGISTRY_SCHEMA_VERSION,
  loadRegistry,
  type ProjectRegistryRecord,
} from "../extensions/bmad-runtime/registry.js";
import { buildNameFirstProjectPicker, confirmProjectVariantChoice, confirmWorkspaceRebind, formatNameFirstProjectPicker, formatProjectPickerDetails, formatResolutionExplanation, formatResolutionResult, isGenericGitRepoIntentRequired, reconcileExistingWorkspace, resolveActiveProject, shouldActivateResolvedProject, shouldBlockProjectInit, type ProjectResolutionResult } from "../extensions/bmad-runtime/resolution.js";
import { getStateFile } from "../extensions/bmad-runtime/state.js";

let tempDirs: string[] = [];

function makeRoot(prefix = "pi-bmad-resolution-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function makeNonTempRoot(prefix = ".tmp-pi-bmad-resolution-"): string {
  const root = fs.mkdtempSync(path.join(process.cwd(), prefix));
  tempDirs.push(root);
  return root;
}

function registryFile(runtimeHome: string): string {
  return path.join(runtimeHome, "projects.json");
}

function writeRegistry(runtimeHome: string, projects: ProjectRegistryRecord[]): void {
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.writeFileSync(
    registryFile(runtimeHome),
    `${JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, projects }, null, 2)}\n`,
    "utf8",
  );
}

function record(root: string, overrides: Partial<ProjectRegistryRecord> = {}): ProjectRegistryRecord {
  return {
    projectId: "proj-1",
    displayName: "Pi BMAD Builder",
    knownRoots: [root],
    artifactRoot: path.join(root, "_bmad-output"),
    runtimeStatePath: getStateFile(root),
    pathAliases: [root],
    lastSeenAt: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeGitRepo(root: string, remote: string): void {
  const git = path.join(root, ".git");
  fs.mkdirSync(path.join(git, "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(git, "config"), `[remote "origin"]\n\turl = ${remote}\n`, "utf8");
  fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n", "utf8");
  fs.writeFileSync(path.join(git, "refs", "heads", "main"), "0123456789abcdef0123456789abcdef01234567\n", "utf8");
}

function fingerprint(remote: string): string {
  return crypto.createHash("sha256").update(remote).digest("hex");
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).replaceAll(path.sep, "/"));
    }
  };
  walk(root);
  return out.sort();
}

function copyBmadWorkspace(from: string, to: string): void {
  fs.cpSync(path.join(from, ".bmad-runtime"), path.join(to, ".bmad-runtime"), { recursive: true });
  fs.cpSync(path.join(from, "_bmad-output"), path.join(to, "_bmad-output"), { recursive: true });
}

function expectExplanationFields(output: string): void {
  expect(output).toContain("## Resolution Explanation");
  expect(output).toContain("Action:");
  expect(output).toContain("Confidence reason:");
  expect(output).toContain("Evidence used:");
  expect(output).toContain("Rejected alternatives:");
  expect(output).toContain("Write occurred:");
  expect(output).toContain("Recovery action:");
  expect(output).toContain("Safe recovery available:");
  expect(output).toContain("Next safe action:");
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("active project resolution", () => {
  it("does not create project files or registry when registry is missing", async () => {
    const root = makeNonTempRoot();
    const runtimeHomeParent = makeRoot();
    const runtimeHome = path.join(runtimeHomeParent, "runtime-home");

    const before = listFiles(root);
    const result = await resolveActiveProject(root, { runtimeHome });

    expect(result.confidence).toBe("blocked");
    expect(result.writeAllowed).toBe(false);
    expect(shouldActivateResolvedProject(result)).toBe(false);
    expect(result.writeOccurred).toBe(false);
    expect(formatResolutionResult(result, root)).toContain("Suspicious CWD Block");
    expect(formatResolutionResult(result, root)).toContain("/bmad-start");
    expect(formatResolutionResult(result, root)).not.toMatch(/future .*flow/i);
    expect(formatResolutionResult(result, root)).toContain("Write occurred: false");
    expect(listFiles(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, ".bmad-runtime"))).toBe(false);
    expect(fs.existsSync(path.join(root, "_bmad-output"))).toBe(false);
    expect(fs.existsSync(registryFile(runtimeHome))).toBe(false);
  });

  it("returns unique_confident with explainable evidence for a single registry candidate", async () => {
    const root = makeNonTempRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [
      record(root, {
        projectId: initialized.identity.projectId,
        displayName: initialized.identity.projectName,
      }),
    ]);
    const before = listFiles(root);

    const result = await resolveActiveProject(root, { runtimeHome });
    const formatted = formatResolutionResult(result, root);

    expect(result.confidence).toBe("unique_confident");
    expect(shouldActivateResolvedProject(result)).toBe(true);
    expect(result.selectedProjectId).toBe(initialized.identity.projectId);
    expect(result.writeAllowed).toBe(true);
    expect(result.evidenceUsed.some((item) => item.label.includes("identity"))).toBe(true);
    expect(result.evidenceUsed.some((item) => item.label.includes("knownRoot"))).toBe(true);
    expect(formatted).toContain("Confidence: unique_confident");
    expect(formatted).toContain("Next safe action");
    expect(formatted).toContain("Project Workspace");
    expect(formatted).toContain("projects.json");
    expect(formatted).toContain("Selected Known Roots");
    expect(listFiles(root)).toEqual(before);
  });

  it("formats every unique confident result with an explainable action and audit fields", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [record(root, { projectId: initialized.identity.projectId, displayName: initialized.identity.projectName })]);

    const result = await resolveActiveProject(root, { runtimeHome });
    const formatted = formatResolutionResult(result, root);
    const explanation = formatResolutionExplanation(result, root);

    expect(formatted).toContain("## Resolution Explanation");
    expectExplanationFields(formatted);
    expect(explanation).toContain("Action: activate_resolved_project");
    expect(explanation).toContain("Confidence reason:");
    expect(explanation).toContain("Evidence used:");
    expect(explanation).toContain("Rejected alternatives:");
    expect(explanation).toContain("- none");
    expect(explanation).toContain("Write occurred: false");
    expect(explanation).toContain("Safe recovery available: not_required");
    expect(explanation).toContain("Next safe action:");
  });

  it("does not accept a single git-only match as unique_confident", async () => {
    const root = makeNonTempRoot();
    const runtimeHome = makeRoot();
    const remote = "https://example.com/acme/runtime.git";
    makeGitRepo(root, remote);
    writeRegistry(runtimeHome, [
      record(path.join(root, "registered-elsewhere"), {
        projectId: "proj-git-only",
        displayName: "Git Only",
        gitEvidence: { remoteUrlFingerprint: fingerprint(remote) },
      }),
    ]);
    const before = listFiles(root);

    const result = await resolveActiveProject(root, { runtimeHome });

    expect(result.confidence).toBe("new_project_intent_required");
    expect(result.writeAllowed).toBe(false);
    expect(shouldActivateResolvedProject(result)).toBe(false);
    expect(result.rejectedCandidates.map((candidate) => candidate.projectId)).toEqual(["proj-git-only"]);
    expect(isGenericGitRepoIntentRequired(result)).toBe(true);
    expect(shouldBlockProjectInit(result).blocked).toBe(true);
    expect(listFiles(root)).toEqual(before);
  });

  it("classifies a generic git repo as explicit BMAD intent required without writes", async () => {
    const root = makeNonTempRoot();
    const runtimeHome = makeRoot();
    const remote = "https://example.com/acme/generic.git";
    makeGitRepo(root, remote);
    writeRegistry(runtimeHome, []);
    const before = listFiles(root);

    const result = await resolveActiveProject(root, { runtimeHome });
    const formatted = formatResolutionResult(result, root);

    expect(result.confidence).toBe("new_project_intent_required");
    expect(result.writeAllowed).toBe(false);
    expect(result.writeOccurred).toBe(false);
    expect(result.genericGitRepo?.worktreePath).toBe(root);
    expect(result.genericGitRepo?.remoteUrlFingerprint).toBe(fingerprint(remote));
    expect(isGenericGitRepoIntentRequired(result)).toBe(true);
    expect(shouldBlockProjectInit(result).blocked).toBe(true);
    expect(shouldBlockProjectInit(result, { confirmGenericGitRepo: true }).blocked).toBe(false);
    expect(formatted).toContain("Generic Git Repository Intent Required");
    expect(formatted).toContain("/bmad init --confirm-generic-repo");
    expect(formatted).not.toContain(remote);
    expect(listFiles(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, ".bmad-runtime"))).toBe(false);
    expect(fs.existsSync(path.join(root, "_bmad-output"))).toBe(false);
  });

  it("does not treat a stray artifact folder as sufficient generic git repo intent", async () => {
    const root = makeNonTempRoot();
    const runtimeHome = makeRoot();
    makeGitRepo(root, "https://example.com/acme/stray-artifacts.git");
    fs.mkdirSync(path.join(root, "_bmad-output"), { recursive: true });
    writeRegistry(runtimeHome, []);

    const result = await resolveActiveProject(root, { runtimeHome });

    expect(result.confidence).toBe("new_project_intent_required");
    expect(isGenericGitRepoIntentRequired(result)).toBe(true);
    expect(shouldBlockProjectInit(result).blocked).toBe(true);
  });

  it("explains weak rejected candidates before requiring explicit project intent", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const remote = "https://example.com/acme/runtime.git";
    makeGitRepo(root, remote);
    ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [
      record(path.join(root, "registered-elsewhere"), {
        projectId: "weak-git-candidate",
        displayName: "Weak Git Candidate",
        gitEvidence: { remoteUrlFingerprint: fingerprint(remote) },
      }),
    ]);

    const result = await resolveActiveProject(root, { runtimeHome });
    const formatted = formatResolutionResult(result, root);

    expect(result.confidence).toBe("new_project_intent_required");
    expect(result.rejectedCandidates.map((candidate) => candidate.projectId)).toEqual(["weak-git-candidate"]);
    expectExplanationFields(formatted);
    expect(formatted).toContain("Action: require_explicit_project_intent");
    expect(formatted).toContain("Rejected alternatives:");
    expect(formatted).toContain("Weak Git Candidate (weak-git-candidate)");
    expect(formatted).toContain("Recovery action: explicit-project-selection-required");
    expect(formatted).toContain("Next safe action:");
  });

  it("blocks a stale registry candidate when cwd has no local BMAD binding", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    writeRegistry(runtimeHome, [record(root, { projectId: "stale-known-root", displayName: "Stale" })]);

    const result = await resolveActiveProject(root, { runtimeHome });
    const formatted = formatResolutionResult(result, root);

    expect(result.confidence).toBe("blocked");
    expect(result.writeAllowed).toBe(false);
    expect(result.suspiciousCwd?.reasons.join("\n")).toContain("no BMAD binding");
    expect(formatted).toContain("Suspicious CWD Block");
  });

  it("requires project variant choice when registry path matches but git evidence differs", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const remote = "https://example.com/acme/runtime.git";
    makeGitRepo(root, remote);
    const initialized = ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [
      record(root, {
        projectId: initialized.identity.projectId,
        displayName: initialized.identity.projectName,
        gitEvidence: { remoteUrlFingerprint: fingerprint(remote), branch: "release" },
      }),
    ]);

    const result = await resolveActiveProject(root, { runtimeHome });
    const formatted = formatResolutionResult(result, root);

    expect(result.confidence).toBe("variant_choice_required");
    expect(result.writeAllowed).toBe(false);
    expect(result.recoveryAction).toBe("choose-project-variant");
    expect(result.evidenceUsed.some((item) => item.label === "registry/git evidence conflict")).toBe(true);
    expect(formatted).toContain("Action: choose_project_variant");
    expect(formatted).toContain("branch differs");
  });

  it("confirms current project variant by updating registry git evidence", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const remote = "https://example.com/acme/runtime.git";
    makeGitRepo(root, remote);
    const initialized = ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [
      record(root, {
        projectId: initialized.identity.projectId,
        displayName: initialized.identity.projectName,
        gitEvidence: { remoteUrlFingerprint: fingerprint(remote), branch: "release" },
      }),
    ]);

    const variant = await confirmProjectVariantChoice(root, { runtimeHome });
    const registry = await loadRegistry({ runtimeHome });
    const after = await resolveActiveProject(root, { runtimeHome });

    expect(variant.ok).toBe(true);
    expect(variant.writeOccurred).toBe(true);
    expect(variant.previousGitEvidence?.branch).toBe("release");
    expect(variant.selectedGitEvidence?.branch).toBe("main");
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    expect(registry.value.projects[0]?.gitEvidence).toMatchObject({
      branch: "main",
      remoteUrlFingerprint: fingerprint(remote),
    });
    expect(after.confidence).toBe("unique_confident");
  });

  it("blocks variant confirmation when resolution is not waiting for variant choice", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    ensureProjectInitialized(root);
    writeRegistry(runtimeHome, []);

    const variant = await confirmProjectVariantChoice(root, { runtimeHome });

    expect(variant.ok).toBe(false);
    expect(variant.writeOccurred).toBe(false);
    expect(variant.recoveryAction).toBe("resolve-variant-choice-before-confirming");
  });

  it("blocks when local identity conflicts with a workspace-matching registry candidate", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [record(root, { projectId: "different-project", displayName: "Different" })]);

    const result = await resolveActiveProject(root, { runtimeHome });

    expect(result.confidence).toBe("blocked");
    expect(result.writeAllowed).toBe(false);
    expect(result.recoveryAction).toBe("resolve-local-identity-registry-conflict");
  });

  it("blocks invalid local identity instead of treating it as absent", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    fs.mkdirSync(path.join(root, ".bmad-runtime"), { recursive: true });
    fs.writeFileSync(path.join(root, ".bmad-runtime", "project-identity.json"), "{not-json", "utf8");
    writeRegistry(runtimeHome, [record(root)]);

    const result = await resolveActiveProject(root, { runtimeHome });

    expect(result.confidence).toBe("blocked");
    expect(result.writeAllowed).toBe(false);
    expect(result.recoveryAction).toBe("repair-project-identity-json");
  });

  it("returns ambiguous without allowing writes when multiple registry candidates match", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const remote = "https://example.com/acme/runtime.git";
    makeGitRepo(root, remote);
    ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [
      record(path.join(root, "first"), { projectId: "proj-1", displayName: "First", gitEvidence: { remoteUrlFingerprint: fingerprint(remote) } }),
      record(path.join(root, "second"), { projectId: "proj-2", displayName: "Second", gitEvidence: { remoteUrlFingerprint: fingerprint(remote) } }),
    ]);

    const result = await resolveActiveProject(root, { runtimeHome });

    expect(result.confidence).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
    expect(result.writeAllowed).toBe(false);
    expect(result.writeOccurred).toBe(false);
    expect(formatResolutionResult(result, root)).toContain("/bmad-start project picker");
    expect(formatResolutionResult(result, root)).toContain("/bmad-start");
    expect(formatResolutionResult(result, root)).toContain("Selection remains conversational through /bmad-start or /bmad start");
    expect(formatResolutionResult(result, root)).not.toContain("read-only in this story");
    expect(formatResolutionResult(result, root)).not.toMatch(/future .*flow/i);
  });

  it("formats ambiguous candidates as a name-first picker ordered by score and recency", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const remote = "https://example.com/acme/runtime.git";
    makeGitRepo(root, remote);
    ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [
      record(path.join(root, "older"), {
        projectId: "older-project",
        displayName: "Older Project",
        lastSeenAt: "2026-06-08T00:00:00.000Z",
        gitEvidence: { remoteUrlFingerprint: fingerprint(remote) },
      }),
      record(path.join(root, "newer"), {
        projectId: "newer-project",
        displayName: "Newer Project",
        lastSeenAt: "2026-06-09T00:00:00.000Z",
        gitEvidence: { remoteUrlFingerprint: fingerprint(remote) },
      }),
    ]);

    const result = await resolveActiveProject(root, { runtimeHome });
    const picker = buildNameFirstProjectPicker(result.candidates);
    const summary = formatNameFirstProjectPicker(result);

    expect(result.confidence).toBe("ambiguous");
    expect(picker.map((item) => item.displayName)).toEqual(["Newer Project", "Older Project"]);
    expect(summary).toContain("1. Newer Project");
    expect(summary).toContain("/bmad start details");
    expect(formatResolutionResult(result, root)).toContain("Technical details are available on demand only");
    expect(summary).not.toContain("Artifact root");
    expect(summary).not.toContain("remote fingerprint");
    expect(formatResolutionResult(result, root)).not.toContain("Artifact root:");
    expect(formatResolutionResult(result, root)).not.toContain("remote fingerprint:");
    expect(formatResolutionResult(result, root)).not.toContain("[newer-project]");
    expect(formatResolutionResult(result, root)).not.toContain("[older-project]");
    expectExplanationFields(formatResolutionResult(result, root));
    expect(formatResolutionResult(result, root)).toContain("Action: show_project_picker");
    expect(formatResolutionResult(result, root)).toContain("Evidence used:");
  });

  it("formats project picker details by index, name, and stable id without writes", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const remote = "https://example.com/acme/runtime.git";
    makeGitRepo(root, remote);
    ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [
      record(path.join(root, "alpha"), {
        projectId: "alpha-project",
        displayName: "Alpha Project",
        historicalAliases: ["Old Alpha"],
        phase: "4-implementation",
        status: "active",
        currentWorkflow: "bmad-dev-story",
        currentStory: "2.4",
        lastSeenAt: "2026-06-09T00:00:00.000Z",
        gitEvidence: { remoteUrlFingerprint: fingerprint(remote), branch: "main", worktreePath: root, commit: "0123456789abcdef0123456789abcdef01234567" },
      }),
      record(path.join(root, "beta"), {
        projectId: "beta-project",
        displayName: "Beta Project",
        lastSeenAt: "2026-06-08T00:00:00.000Z",
        gitEvidence: { remoteUrlFingerprint: fingerprint(remote) },
      }),
    ]);
    const before = listFiles(root);

    const result = await resolveActiveProject(root, { runtimeHome });
    const byIndex = formatProjectPickerDetails(result, "1", root);
    const byName = formatProjectPickerDetails(result, "Alpha Project", root);
    const byId = formatProjectPickerDetails(result, "alpha-project", root);

    expect(byIndex).toContain("Stable ID: alpha-project");
    expect(byName).toContain("Historical aliases: Old Alpha");
    expect(byId).toContain("Artifact root:");
    expect(byId).toContain("remote fingerprint:");
    expect(byId).toContain("Decision persistence: read-only details request");
    expect(listFiles(root)).toEqual(before);
  });

  it("requires index or stable id when picker detail selector matches duplicate names", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const remote = "https://example.com/acme/runtime.git";
    makeGitRepo(root, remote);
    ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [
      record(path.join(root, "a"), { projectId: "project-a", displayName: "Project A", gitEvidence: { remoteUrlFingerprint: fingerprint(remote) } }),
      record(path.join(root, "b"), { projectId: "project-b", displayName: "Project B", gitEvidence: { remoteUrlFingerprint: fingerprint(remote) } }),
    ]);

    const result = await resolveActiveProject(root, { runtimeHome });
    result.candidates[0]!.displayName = "Duplicate";
    result.candidates[1]!.displayName = "Duplicate";
    const duplicate = formatProjectPickerDetails(result, "Duplicate", root);
    const byId = formatProjectPickerDetails(result, "project-b", root);

    expect(duplicate).toContain("matches multiple picker items");
    expect(duplicate).toContain("No state or registry decision was recorded");
    expect(byId).toContain("Stable ID: project-b");
  });

  it("does not show picker details for non-ambiguous results", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [record(root, { projectId: initialized.identity.projectId, displayName: initialized.identity.projectName })]);

    const result = await resolveActiveProject(root, { runtimeHome });

    expect(result.confidence).toBe("unique_confident");
    expect(formatProjectPickerDetails(result, "1", root)).toContain("available only for ambiguous");
  });

  it("blocks empty suspicious cwd with explicit no-write recovery", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    writeRegistry(runtimeHome, []);
    const before = listFiles(root);

    const result = await resolveActiveProject(root, { runtimeHome });

    const formatted = formatResolutionResult(result, root);

    expect(result.confidence).toBe("blocked");
    expect(result.writeAllowed).toBe(false);
    expect(result.suspiciousCwd?.affectedPath).toBe(root);
    expect(result.recoveryAction).toBe("navigate-to-known-project-or-use-explicit-init-or-dedicated-workspace-flow");
    expect(formatted).toContain("Suspicious CWD Block");
    expectExplanationFields(formatted);
    expect(formatted).toContain("Affected path");
    expect(formatted).toContain("Recovery");
    expect(formatted).toContain("Action: repair_before_retry");
    expect(formatted).toContain("Write occurred: false");
    expect(formatted).toContain("Recovery action: navigate-to-known-project-or-use-explicit-init-or-dedicated-workspace-flow");
    expect(listFiles(root)).toEqual(before);
  });

  it("declares when no safe recovery action is available", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    writeRegistry(runtimeHome, []);

    const result = await resolveActiveProject(root, { runtimeHome });
    const withoutRecovery: ProjectResolutionResult = { ...result, recoveryAction: undefined };

    const explanation = formatResolutionExplanation(withoutRecovery, root);
    expect(explanation).toContain("Safe recovery available: no");
    expect(explanation).toContain("No safe recovery action is available");
    expect(explanation).toContain("Next safe action: none; stop and repair the blocking condition before retrying");
    expect(explanation).not.toMatch(/\/bmad init|reconcile|activate/i);
  });

  it("recognizes an existing local BMAD workspace missing from the registry", async () => {
    const root = makeRoot();
    const runtimeHomeParent = makeRoot();
    const runtimeHome = path.join(runtimeHomeParent, "runtime-home");
    const initialized = ensureProjectInitialized(root);
    const before = listFiles(root);

    const result = await resolveActiveProject(root, { runtimeHome });
    const formatted = formatResolutionResult(result, root);

    expect(result.confidence).toBe("local_workspace_unregistered");
    expect(result.localWorkspace?.projectId).toBe(initialized.identity.projectId);
    expect(result.reconcileAllowed).toBe(true);
    expect(result.writeAllowed).toBe(false);
    expect(shouldActivateResolvedProject(result)).toBe(false);
    expect(formatted).toContain("Local Workspace Candidate");
    expectExplanationFields(formatted);
    expect(formatted).toContain("Reconcile allowed: true");
    expect(formatted).toContain("Action: reconcile_existing_workspace");
    expect(formatted).toContain("Recovery action: reconcile-existing-workspace");
    expect(listFiles(root)).toEqual(before);
    expect(fs.existsSync(registryFile(runtimeHome))).toBe(false);
  });

  it("recognizes an existing local workspace when registry already has unrelated projects", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [record(path.join(root, "other"), { projectId: "other-project", displayName: "Other" })]);

    const result = await resolveActiveProject(root, { runtimeHome });

    expect(result.confidence).toBe("local_workspace_unregistered");
    expect(result.localWorkspace?.projectId).toBe(initialized.identity.projectId);
    expect(result.reconcileAllowed).toBe(true);
  });

  it("classifies a moved workspace with matching stable identity as needs_rebind without writes", async () => {
    const oldRoot = makeRoot();
    const movedRoot = makeRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(oldRoot);
    copyBmadWorkspace(oldRoot, movedRoot);
    writeRegistry(runtimeHome, [
      record(oldRoot, {
        projectId: initialized.identity.projectId,
        displayName: initialized.identity.projectName,
      }),
    ]);
    const before = listFiles(movedRoot);

    const result = await resolveActiveProject(movedRoot, { runtimeHome });
    const formatted = formatResolutionResult(result, movedRoot);

    expect(result.confidence).toBe("needs_rebind");
    expect(result.selectedProjectId).toBe(initialized.identity.projectId);
    expect(result.writeAllowed).toBe(false);
    expect(result.writeOccurred).toBe(false);
    expect(shouldActivateResolvedProject(result)).toBe(false);
    expect(shouldBlockProjectInit(result).blocked).toBe(true);
    expect(formatted).toContain("Action: confirm_workspace_rebind");
    expect(formatted).toContain("Recovery action: confirm-workspace-rebind");
    expect(listFiles(movedRoot)).toEqual(before);
  });

  it("confirms moved workspace rebind by adding current root while preserving stable id", async () => {
    const oldRoot = makeRoot();
    const movedRoot = makeRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(oldRoot);
    copyBmadWorkspace(oldRoot, movedRoot);
    writeRegistry(runtimeHome, [
      record(oldRoot, {
        projectId: initialized.identity.projectId,
        displayName: initialized.identity.projectName,
      }),
    ]);
    const beforeProjectFiles = listFiles(movedRoot);

    const rebind = await confirmWorkspaceRebind(movedRoot, { runtimeHome });
    const registry = await loadRegistry({ runtimeHome });
    const afterResolution = await resolveActiveProject(movedRoot, { runtimeHome });

    expect(rebind.ok).toBe(true);
    expect(rebind.writeOccurred).toBe(true);
    expect(rebind.projectId).toBe(initialized.identity.projectId);
    expect(rebind.previousKnownRoots).toEqual([oldRoot]);
    expect(rebind.addedKnownRoot).toBe(movedRoot);
    expect(listFiles(movedRoot)).toEqual(beforeProjectFiles);
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    const project = registry.value.projects[0]!;
    expect(project.projectId).toBe(initialized.identity.projectId);
    expect(project.knownRoots).toContain(oldRoot);
    expect(project.knownRoots).toContain(movedRoot);
    expect(project.pathAliases).toContain(movedRoot);
    expect(project.artifactRoot).toBe(path.join(movedRoot, "_bmad-output"));
    expect(project.runtimeStatePath).toBe(getStateFile(movedRoot));
    expect(afterResolution.confidence).toBe("unique_confident");
  });

  it("blocks rebind confirmation when resolution lacks matching local identity evidence", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    writeRegistry(runtimeHome, []);

    const rebind = await confirmWorkspaceRebind(root, { runtimeHome });

    expect(rebind.ok).toBe(false);
    expect(rebind.writeOccurred).toBe(false);
    expect(rebind.recoveryAction).toBe("resolve-needs-rebind-before-confirming");
  });

  it("blocks moved workspace rebind before confirmation when another registry project owns the current root", async () => {
    const oldRoot = makeRoot();
    const movedRoot = makeRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(oldRoot);
    copyBmadWorkspace(oldRoot, movedRoot);
    writeRegistry(runtimeHome, [
      record(oldRoot, {
        projectId: initialized.identity.projectId,
        displayName: initialized.identity.projectName,
      }),
      record(movedRoot, {
        projectId: "other-project",
        displayName: "Other Project",
      }),
    ]);

    const rebind = await confirmWorkspaceRebind(movedRoot, { runtimeHome });

    expect(rebind.ok).toBe(false);
    expect(rebind.writeOccurred).toBe(false);
    expect(rebind.recoveryAction).toBe("resolve-needs-rebind-before-confirming");
  });

  it("reconciles an existing workspace into registry metadata without moving artifacts", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const initialized = ensureProjectInitialized(root);
    const beforeProjectFiles = listFiles(root);

    const reconciled = await reconcileExistingWorkspace(root, { runtimeHome });
    const registry = await loadRegistry({ runtimeHome });

    expect(reconciled.ok).toBe(true);
    expect(reconciled.writeOccurred).toBe(true);
    expect(reconciled.projectId).toBe(initialized.identity.projectId);
    expect(listFiles(root)).toEqual(beforeProjectFiles);
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    expect(registry.value.projects[0]).toMatchObject({
      projectId: initialized.identity.projectId,
      displayName: initialized.identity.projectName,
      knownRoots: [root],
      artifactRoot: path.join(root, "_bmad-output"),
      runtimeStatePath: getStateFile(root),
      pathAliases: [root],
    });
  });

  it("blocks reconcile when another registry project already owns the workspace paths", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    ensureProjectInitialized(root);
    writeRegistry(runtimeHome, [record(root, { projectId: "conflicting-project", displayName: "Conflict" })]);

    const reconciled = await reconcileExistingWorkspace(root, { runtimeHome });

    expect(reconciled.ok).toBe(false);
    expect(reconciled.writeOccurred).toBe(false);
    expect(reconciled.recoveryAction).toBe("resolve-registry-workspace-conflict-before-reconcile");
  });

  it("returns recovery when reconcile registry write fails", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    ensureProjectInitialized(root);

    const reconciled = await reconcileExistingWorkspace(root, {
      runtimeHome,
      hooks: {
        beforeReplace() {
          throw new Error("simulated replace failure");
        },
      },
    });

    expect(reconciled.ok).toBe(false);
    expect(reconciled.writeOccurred).toBe(true);
    expect(reconciled.recoveryAction).toBeTruthy();
    expect(reconciled.error).toContain("Registry");
  });

  it("blocks existing workspace recognition when baseline lock is invalid", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    ensureProjectInitialized(root);
    fs.writeFileSync(path.join(root, ".bmad-runtime", "baseline-lock.json"), "{not-json", "utf8");

    const result = await resolveActiveProject(root, { runtimeHome });
    const reconciled = await reconcileExistingWorkspace(root, { runtimeHome });

    expect(result.confidence).toBe("blocked");
    expect(result.recoveryAction).toBe("repair-baseline-lock-json");
    expect(reconciled.ok).toBe(false);
    expect(reconciled.recoveryAction).toBe("repair-baseline-lock-json");
  });

  it("recognizes v0.1.1-like local workspace metadata without baseline lock", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    fs.mkdirSync(path.join(root, ".bmad-runtime"), { recursive: true });
    fs.mkdirSync(path.join(root, "_bmad-output"), { recursive: true });
    fs.writeFileSync(path.join(root, ".bmad-runtime", "state.json"), `${JSON.stringify({ version: 1, active: false, mode: "interview", track: "bmad-method", phase: "2-planning", workflowHistory: [], autonomy: { phase3And4Yolo: true, askUserOnlyFor: [] }, createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:00:00.000Z", parkingLot: [] }, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(root, ".bmad-runtime", "project-identity.json"), `${JSON.stringify({ version: 1, projectId: "legacy-proj", projectName: "Legacy Workspace", createdAt: "2026-06-09T00:00:00.000Z", rootFingerprint: { initialPath: root, bmadOutputRoot: "_bmad-output" }, clonePolicy: "new-id-by-default" }, null, 2)}\n`, "utf8");
    writeRegistry(runtimeHome, []);

    const result = await resolveActiveProject(root, { runtimeHome });

    expect(result.confidence).toBe("local_workspace_unregistered");
    expect(result.localWorkspace?.compatibility).toBe("v0.1.1-compatible");
  });

  it("does not match artifactRoot/runtimeStatePath when local files do not exist", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    writeRegistry(runtimeHome, [
      record(path.join(root, "not-cwd"), {
        projectId: "artifact-only",
        displayName: "Artifact Only",
        artifactRoot: path.join(root, "_bmad-output"),
        runtimeStatePath: getStateFile(root),
        knownRoots: [path.join(root, "not-cwd")],
        pathAliases: [],
      }),
    ]);

    const result = await resolveActiveProject(root, { runtimeHome });

    expect(result.confidence).toBe("blocked");
    expect(result.suspiciousCwd?.reasons.join("\n")).toContain("outside all known registry roots");
    expect(result.candidates).toHaveLength(0);
    expect(result.writeAllowed).toBe(false);
  });
});
