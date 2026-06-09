import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RECOMMENDED_PACKAGES, formatHealthReport, runHealthCheck } from "../extensions/bmad-runtime/health.js";
import { ensureProjectInitialized } from "../extensions/bmad-runtime/project.js";
import { REGISTRY_SCHEMA_VERSION } from "../extensions/bmad-runtime/registry.js";

let tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-health-"));
  tempDirs.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function writeHealthyBmadConfig(root: string): void {
  writeFile(root, "_bmad/_config/bmad-help.csv", "module,skill,display-name,menu-code,description,action,args,phase,after,before,required,output-location,outputs\nBMad Method,bmad-create-prd,Create PRD,CP,,,,2-planning,,,true,planning_artifacts,prd\n");
  writeFile(root, "_bmad/_config/manifest.yaml", "modules:\n  - core\n  - bmm\n");
  writeFile(root, ".pi/settings.json", JSON.stringify({ packages: RECOMMENDED_PACKAGES.map((name) => `npm:${name}`) }, null, 2));
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
}

function registryFile(runtimeHome: string): string {
  return path.join(runtimeHome, "projects.json");
}

function writeRegistry(runtimeHome: string, root: string): void {
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.writeFileSync(registryFile(runtimeHome), `${JSON.stringify({
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    projects: [{
      projectId: "health-project",
      displayName: "Health Project",
      historicalAliases: [],
      knownRoots: [root],
      artifactRoot: path.join(root, "_bmad-output"),
      runtimeStatePath: path.join(root, ".bmad-runtime", "state.json"),
      pathAliases: [root],
      lastSeenAt: "2026-06-09T17:30:00.000Z",
    }],
  }, null, 2)}\n`, "utf8");
}

function makeGitRepo(root: string, remote: string): void {
  const git = path.join(root, ".git");
  fs.mkdirSync(path.join(git, "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(git, "config"), `[remote "origin"]\n\turl = ${remote}\n`, "utf8");
  fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n", "utf8");
  fs.writeFileSync(path.join(git, "refs", "heads", "main"), "0123456789abcdef0123456789abcdef01234567\n", "utf8");
}

function listFiles(root: string): string[] {
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

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("runHealthCheck", () => {
  it("reports a healthy fixture without blocked findings", () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    ensureProjectInitialized(root);
    writeHealthyBmadConfig(root);
    writeRegistry(runtimeHome, root);

    const report = runHealthCheck(root, process.cwd(), { runtimeHome });

    expect(report.counts.blocked).toBe(0);
    expect(report.boundaries.map((boundary) => boundary.label)).toEqual([
      "Runtime Package",
      "Runtime Home",
      "Project Workspace",
      "Target Code Repo",
    ]);
    expect(formatHealthReport(report)).toContain("## Runtime Boundaries");
    expect(formatHealthReport(report)).toContain(`Registry: ${registryFile(runtimeHome)}`);
    expect(formatHealthReport(report)).toContain("Target Code Repo");
    expect(report.findings.some((finding) => finding.label === "Registry schema" && finding.severity === "ok")).toBe(true);
    expect(report.findings.some((finding) => finding.label === "Registry migration" && finding.severity === "ok")).toBe(true);
    expect(report.findings.some((finding) => finding.label === "BMAD catalog" && finding.severity === "ok")).toBe(true);
    expect(report.findings.some((finding) => finding.label === "Project identity" && finding.severity === "ok")).toBe(true);
    expect(report.findings.filter((finding) => finding.label.startsWith("Adapter package:")).every((finding) => finding.severity === "ok")).toBe(true);
    expect(report.findings.some((finding) => finding.label === "Smoke command: npm test" && finding.severity === "ok")).toBe(true);
  });

  it("reports missing catalog as blocked and missing adapters as degraded", () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    ensureProjectInitialized(root);
    writeRegistry(runtimeHome, root);

    const report = runHealthCheck(root, process.cwd(), { runtimeHome });

    expect(report.findings.some((finding) => finding.label === "BMAD catalog" && finding.severity === "blocked")).toBe(true);
    expect(report.findings.some((finding) => finding.label.startsWith("Adapter package:") && finding.severity === "degraded")).toBe(true);
  });

  it("points missing runtime/project scaffolding recovery at /bmad-start first", () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();

    const formatted = formatHealthReport(runHealthCheck(root, process.cwd(), { runtimeHome }));

    expect(formatted).toContain("/bmad-start");
    expect(formatted).toContain("/bmad init only for explicit repair");
  });

  it("reports registry, git, lock and recovery diagnostics without leaking remote URL", () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    const remote = "https://example.com/private/repo.git";
    ensureProjectInitialized(root);
    writeHealthyBmadConfig(root);
    writeRegistry(runtimeHome, root);
    makeGitRepo(root, remote);
    fs.writeFileSync(`${registryFile(runtimeHome)}.lock`, "lock", "utf8");

    const formatted = formatHealthReport(runHealthCheck(root, process.cwd(), { runtimeHome }));

    expect(formatted).toContain("Registry schema: schemaVersion=1");
    expect(formatted).toContain("Registry lock: Lock file present");
    expect(formatted).toContain("Recovery: Confirm no active writer is running");
    expect(formatted).toContain("Git evidence: branch=main");
    expect(formatted).toContain(crypto.createHash("sha256").update(remote).digest("hex"));
    expect(formatted).not.toContain(remote);
    expect(formatted).toContain("Path normalization");
    expect(formatted).toContain("Project preflight availability");
  });

  it("classifies invalid registry schema with recovery", () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    ensureProjectInitialized(root);
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(registryFile(runtimeHome), "{invalid", "utf8");

    const formatted = formatHealthReport(runHealthCheck(root, process.cwd(), { runtimeHome }));

    expect(formatted).toContain("[blocked] Registry schema: Registry JSON is invalid");
    expect(formatted).toContain("Recovery: Repair JSON or restore registry from backup before project resolution/resume.");
  });

  it("does not create project files while formatting diagnostics", () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    ensureProjectInitialized(root);
    writeHealthyBmadConfig(root);
    writeRegistry(runtimeHome, root);
    const before = listFiles(root);
    const beforeRuntimeHome = listFiles(runtimeHome);

    const report = runHealthCheck(root, process.cwd(), { runtimeHome });
    formatHealthReport(report);

    expect(listFiles(root)).toEqual(before);
    expect(listFiles(runtimeHome)).toEqual(beforeRuntimeHome);
  });
});
