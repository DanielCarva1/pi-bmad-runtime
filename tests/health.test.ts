import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RECOMMENDED_PACKAGES, runHealthCheck } from "../extensions/bmad-runtime/health.js";
import { ensureProjectInitialized } from "../extensions/bmad-runtime/project.js";

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

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("runHealthCheck", () => {
  it("reports a healthy fixture without blocked findings", () => {
    const root = makeRoot();
    ensureProjectInitialized(root);
    writeHealthyBmadConfig(root);

    const report = runHealthCheck(root, process.cwd());

    expect(report.counts.blocked).toBe(0);
    expect(report.findings.some((finding) => finding.label === "BMAD catalog" && finding.severity === "ok")).toBe(true);
    expect(report.findings.some((finding) => finding.label === "Project identity" && finding.severity === "ok")).toBe(true);
    expect(report.findings.filter((finding) => finding.label.startsWith("Adapter package:")).every((finding) => finding.severity === "ok")).toBe(true);
  });

  it("reports missing catalog as blocked and missing adapters as degraded", () => {
    const root = makeRoot();
    ensureProjectInitialized(root);

    const report = runHealthCheck(root, process.cwd());

    expect(report.findings.some((finding) => finding.label === "BMAD catalog" && finding.severity === "blocked")).toBe(true);
    expect(report.findings.some((finding) => finding.label.startsWith("Adapter package:") && finding.severity === "degraded")).toBe(true);
  });
});
