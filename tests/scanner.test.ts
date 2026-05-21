import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBmadCatalog } from "../extensions/bmad-runtime/catalog.js";
import { recommendNext } from "../extensions/bmad-runtime/scanner.js";
import type { BmadPathConfig } from "../extensions/bmad-runtime/paths.js";

const csv = `module,skill,display-name,menu-code,description,action,args,phase,after,before,required,output-location,outputs
BMad Method,bmad-create-prd,Create PRD,CP,,,,2-planning,,,true,planning_artifacts,prd
BMad Method,bmad-create-architecture,Create Architecture,CA,,,,3-solutioning,bmad-create-prd,,true,planning_artifacts,architecture
BMad Method,bmad-create-epics-and-stories,Create Epics and Stories,CE,,,,3-solutioning,bmad-create-architecture,,true,planning_artifacts,epics and stories
`;

let tempDirs: string[] = [];
function makeCfg(): BmadPathConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-runtime-test-"));
  tempDirs.push(root);
  const planning = path.join(root, "_bmad-output", "planning-artifacts");
  fs.mkdirSync(planning, { recursive: true });
  return {
    projectRoot: root,
    output_folder: path.join(root, "_bmad-output"),
    planning_artifacts: planning,
    implementation_artifacts: path.join(root, "_bmad-output", "implementation-artifacts"),
    project_knowledge: path.join(root, "docs"),
    "project-knowledge": path.join(root, "docs"),
  };
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("recommendNext", () => {
  it("recommends the earliest incomplete required workflow", () => {
    const rows = parseBmadCatalog(csv);
    const cfg = makeCfg();
    expect(recommendNext(rows, cfg).row?.menuCode).toBe("CP");
  });

  it("moves forward when artifact evidence exists", () => {
    const rows = parseBmadCatalog(csv);
    const cfg = makeCfg();
    fs.writeFileSync(path.join(cfg.planning_artifacts, "prd.md"), "# PRD\n", "utf8");
    expect(recommendNext(rows, cfg).row?.menuCode).toBe("CA");
  });

  it("respects dependency order", () => {
    const rows = parseBmadCatalog(csv);
    const cfg = makeCfg();
    fs.writeFileSync(path.join(cfg.planning_artifacts, "architecture.md"), "# Architecture\n", "utf8");
    expect(recommendNext(rows, cfg).row?.menuCode).toBe("CP");
  });
});
