import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProjectInitialized } from "../extensions/bmad-runtime/project.js";
import { REGISTRY_SCHEMA_VERSION, type ProjectRegistryRecord } from "../extensions/bmad-runtime/registry.js";
import { confirmWorkspaceRebind, isGenericGitRepoIntentRequired, resolveActiveProject, shouldBlockProjectInit, type ProjectResolutionResult } from "../extensions/bmad-runtime/resolution.js";
import {
  buildExpansiveSearchGuardEvidence,
  formatResolutionWorkspaceSmokeReport,
  validateExpansiveSearchGuardEvidence,
  validateResolutionWorkspaceSmokeResults,
  type ResolutionWorkspaceSmokeResult,
  type ResolutionWorkspaceSmokeScenario,
} from "../extensions/bmad-runtime/smoke.js";
import { getStateFile } from "../extensions/bmad-runtime/state.js";
import { createDedicatedWorkspace } from "../extensions/bmad-runtime/workspace.js";

let tempDirs: string[] = [];

function makeRoot(prefix = "pi-bmad-smoke-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function makeNonTempRoot(prefix = ".tmp-pi-bmad-smoke-"): string {
  const root = fs.mkdtempSync(path.join(process.cwd(), prefix));
  tempDirs.push(root);
  return root;
}

function registryFile(runtimeHome: string): string {
  return path.join(runtimeHome, "projects.json");
}

function registryCount(runtimeHome: string): number {
  if (!fs.existsSync(registryFile(runtimeHome))) return 0;
  const parsed = JSON.parse(fs.readFileSync(registryFile(runtimeHome), "utf8")) as { projects?: unknown[] };
  return Array.isArray(parsed.projects) ? parsed.projects.length : 0;
}

function registryProjectIds(runtimeHome: string): string[] {
  if (!fs.existsSync(registryFile(runtimeHome))) return [];
  const parsed = JSON.parse(fs.readFileSync(registryFile(runtimeHome), "utf8")) as { projects?: Array<{ projectId?: string }> };
  return Array.isArray(parsed.projects) ? parsed.projects.map((project) => project.projectId ?? "") : [];
}

function writeRegistry(runtimeHome: string, projects: ProjectRegistryRecord[]): void {
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.writeFileSync(
    registryFile(runtimeHome),
    `${JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, projects, updatedAt: "2026-06-09T00:00:00.000Z" }, null, 2)}\n`,
    "utf8",
  );
}

function record(root: string, overrides: Partial<ProjectRegistryRecord> = {}): ProjectRegistryRecord {
  return {
    projectId: "proj-1",
    displayName: "Pi BMAD Builder",
    historicalAliases: [],
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

function copyBmadWorkspace(from: string, to: string): void {
  fs.cpSync(path.join(from, ".bmad-runtime"), path.join(to, ".bmad-runtime"), { recursive: true });
  fs.cpSync(path.join(from, "_bmad-output"), path.join(to, "_bmad-output"), { recursive: true });
}

function evidenceLabels(result: ProjectResolutionResult): string[] {
  return result.evidenceUsed.map((item) => `${item.kind}:${item.label}`);
}

function smokeResult(input: {
  scenario: ResolutionWorkspaceSmokeScenario;
  expectedResult: string;
  confidenceClass: string;
  evidenceUsed: string[];
  projectCountBefore: number;
  projectCountAfter: number;
  writeOccurred: boolean;
  recoveryAction?: string;
  duplicateCreationPrevented?: boolean;
}): ResolutionWorkspaceSmokeResult {
  return {
    scenario: input.scenario,
    expectedResult: input.expectedResult,
    confidenceClass: input.confidenceClass,
    evidenceUsed: input.evidenceUsed,
    duplicateCreationPrevented: input.duplicateCreationPrevented ?? input.projectCountAfter <= input.projectCountBefore,
    writeOccurred: input.writeOccurred,
    projectCountBefore: input.projectCountBefore,
    projectCountAfter: input.projectCountAfter,
    recoveryAction: input.recoveryAction,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("P0 resolution and workspace smoke suite", () => {
  it("rejects duplicate scenario records in the smoke contract", () => {
    const base: ResolutionWorkspaceSmokeResult = {
      scenario: "same-cwd",
      expectedResult: "activate",
      confidenceClass: "unique_confident",
      evidenceUsed: ["registry:match"],
      duplicateCreationPrevented: true,
      writeOccurred: false,
      projectCountBefore: 1,
      projectCountAfter: 1,
    };

    const validation = validateResolutionWorkspaceSmokeResults([
      base,
      { ...base },
      ...[
        "different-cwd-block",
        "moved-workspace-rebind",
        "ambiguous-project-picker",
        "generic-git-intent",
        "local-only-workspace",
      ].map((scenario) => ({ ...base, scenario: scenario as ResolutionWorkspaceSmokeScenario })),
    ]);

    expect(validation.ok).toBe(false);
    expect(validation.failures).toContain("same-cwd: duplicate scenario result");
  });

  it("executes required P0 scenarios with evidence, confidence and duplicate-prevention records", async () => {
    const results: ResolutionWorkspaceSmokeResult[] = [];

    {
      const root = makeRoot();
      const runtimeHome = makeRoot();
      const initialized = ensureProjectInitialized(root);
      writeRegistry(runtimeHome, [record(root, { projectId: initialized.identity.projectId, displayName: initialized.identity.projectName })]);
      const before = registryCount(runtimeHome);
      const result = await resolveActiveProject(root, { runtimeHome });
      results.push(smokeResult({
        scenario: "same-cwd",
        expectedResult: "activate resolved project",
        confidenceClass: result.confidence,
        evidenceUsed: evidenceLabels(result),
        writeOccurred: result.writeOccurred,
        projectCountBefore: before,
        projectCountAfter: registryCount(runtimeHome),
      }));
      expect(result.confidence).toBe("unique_confident");
    }

    {
      const projectRoot = makeRoot();
      const otherCwd = makeRoot();
      const runtimeHome = makeRoot();
      const initialized = ensureProjectInitialized(projectRoot);
      writeRegistry(runtimeHome, [record(projectRoot, { projectId: initialized.identity.projectId, displayName: initialized.identity.projectName })]);
      const before = registryCount(runtimeHome);
      const result = await resolveActiveProject(otherCwd, { runtimeHome });
      results.push(smokeResult({
        scenario: "different-cwd-block",
        expectedResult: "block suspicious cwd and avoid duplicate creation",
        confidenceClass: result.confidence,
        evidenceUsed: evidenceLabels(result),
        writeOccurred: result.writeOccurred,
        projectCountBefore: before,
        projectCountAfter: registryCount(runtimeHome),
        recoveryAction: result.recoveryAction,
      }));
      expect(result.confidence).toBe("blocked");
      expect(result.writeOccurred).toBe(false);
    }

    {
      const oldRoot = makeRoot();
      const movedRoot = makeRoot();
      const runtimeHome = makeRoot();
      const initialized = ensureProjectInitialized(oldRoot);
      copyBmadWorkspace(oldRoot, movedRoot);
      writeRegistry(runtimeHome, [record(oldRoot, { projectId: initialized.identity.projectId, displayName: initialized.identity.projectName })]);
      const before = registryCount(runtimeHome);
      const resolution = await resolveActiveProject(movedRoot, { runtimeHome });
      const rebind = await confirmWorkspaceRebind(movedRoot, { runtimeHome });
      const after = await resolveActiveProject(movedRoot, { runtimeHome });
      results.push(smokeResult({
        scenario: "moved-workspace-rebind",
        expectedResult: "needs rebind, then resolves without creating a duplicate project",
        confidenceClass: `${resolution.confidence}->${after.confidence}`,
        evidenceUsed: [...evidenceLabels(resolution), ...rebind.compatibilityEvidence.map((item) => `${item.kind}:${item.label}`)],
        writeOccurred: resolution.writeOccurred || rebind.writeOccurred || after.writeOccurred,
        projectCountBefore: before,
        projectCountAfter: registryCount(runtimeHome),
        recoveryAction: resolution.recoveryAction,
      }));
      expect(resolution.confidence).toBe("needs_rebind");
      expect(rebind.ok).toBe(true);
      expect(after.confidence).toBe("unique_confident");
    }

    {
      const root = makeRoot();
      const runtimeHome = makeRoot();
      const remote = "https://example.com/acme/runtime.git";
      makeGitRepo(root, remote);
      ensureProjectInitialized(root);
      writeRegistry(runtimeHome, [
        record(path.join(root, "first"), { projectId: "proj-1", displayName: "First", gitEvidence: { remoteUrlFingerprint: fingerprint(remote) } }),
        record(path.join(root, "second"), { projectId: "proj-2", displayName: "Second", gitEvidence: { remoteUrlFingerprint: fingerprint(remote) } }),
      ]);
      const before = registryCount(runtimeHome);
      const result = await resolveActiveProject(root, { runtimeHome });
      results.push(smokeResult({
        scenario: "ambiguous-project-picker",
        expectedResult: "show explicit project picker",
        confidenceClass: result.confidence,
        evidenceUsed: evidenceLabels(result),
        writeOccurred: result.writeOccurred,
        projectCountBefore: before,
        projectCountAfter: registryCount(runtimeHome),
        recoveryAction: result.recoveryAction,
      }));
      expect(result.confidence).toBe("ambiguous");
    }

    {
      const root = makeNonTempRoot();
      const runtimeHome = makeRoot();
      const remote = "https://example.com/acme/generic.git";
      makeGitRepo(root, remote);
      writeRegistry(runtimeHome, []);
      const before = registryCount(runtimeHome);
      const result = await resolveActiveProject(root, { runtimeHome });
      results.push(smokeResult({
        scenario: "generic-git-intent",
        expectedResult: "require explicit BMAD intent before init",
        confidenceClass: result.confidence,
        evidenceUsed: evidenceLabels(result),
        writeOccurred: result.writeOccurred,
        projectCountBefore: before,
        projectCountAfter: registryCount(runtimeHome),
        recoveryAction: result.recoveryAction,
      }));
      expect(result.confidence).toBe("new_project_intent_required");
      expect(isGenericGitRepoIntentRequired(result)).toBe(true);
      expect(shouldBlockProjectInit(result).blocked).toBe(true);
    }

    {
      const source = makeRoot();
      const dedicatedRoot = makeRoot();
      const runtimeHome = makeRoot();
      const before = registryCount(runtimeHome);
      const result = await createDedicatedWorkspace({ cwd: source, projectName: "Local Smoke", rootPreference: dedicatedRoot, rootSource: "flag" }, { runtimeHome });
      const ids = registryProjectIds(runtimeHome);
      results.push(smokeResult({
        scenario: "local-only-workspace",
        expectedResult: "create one dedicated local workspace without git remote",
        confidenceClass: result.ok ? "workspace_created" : "workspace_blocked",
        evidenceUsed: [
          `workspace:${result.workspacePath ?? "none"}`,
          `project:${result.projectId ?? "none"}`,
          `evidence:${result.evidencePath ?? "none"}`,
        ],
        writeOccurred: result.writeOccurred,
        projectCountBefore: before,
        projectCountAfter: registryCount(runtimeHome),
        duplicateCreationPrevented: result.ok && ids.length === new Set(ids).size && registryCount(runtimeHome) === before + 1,
        recoveryAction: result.ok ? undefined : result.recoveryAction,
      }));
      expect(result.ok).toBe(true);
    }

    const guard = buildExpansiveSearchGuardEvidence({
      explicitIntentProvided: false,
      root: makeRoot(),
      maxDepth: 2,
      bounds: ["workspace-root", "runtime-home-registry"],
      reason: "cwd did not match known roots; broad filesystem search would risk wrong-project activation",
    });
    const validation = validateResolutionWorkspaceSmokeResults(results);
    const guardValidation = validateExpansiveSearchGuardEvidence(guard);
    const report = formatResolutionWorkspaceSmokeReport(results, guard);

    expect(validation.ok).toBe(true);
    expect(guard.blocked).toBe(true);
    expect(guardValidation.ok).toBe(true);
    expect(report).toContain("Smoke suite: pass");
    expect(report).toContain("different-cwd-block");
    expect(report).toContain("expansive-search-guard");
    expect(report).toContain("Write occurred: false");
  });
});
