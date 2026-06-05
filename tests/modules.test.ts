import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICIAL_BMAD_MODULES, scanOfficialBmadModules } from "../extensions/bmad-runtime/modules.js";

let tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-modules-"));
  tempDirs.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("scanOfficialBmadModules", () => {
  it("reports all official modules present from config files", () => {
    const root = makeRoot();
    for (const moduleId of OFFICIAL_BMAD_MODULES) writeFile(root, `_bmad/${moduleId}/config.yaml`, "enabled: true\n");

    const modules = scanOfficialBmadModules(root);

    expect(modules).toHaveLength(OFFICIAL_BMAD_MODULES.length);
    expect(modules.every((entry) => entry.present)).toBe(true);
  });

  it("reports missing modules with reconcile hints", () => {
    const root = makeRoot();
    writeFile(root, "_bmad/core/config.yaml", "enabled: true\n");
    writeFile(root, "_bmad/bmm/config.yaml", "enabled: true\n");

    const modules = scanOfficialBmadModules(root);
    const missing = modules.filter((entry) => !entry.present);

    expect(missing.map((entry) => entry.module)).toEqual(["bmb", "cis", "gds", "tea"]);
    expect(missing.every((entry) => entry.hint?.includes("guided BMAD reconcile"))).toBe(true);
  });

  it("detects module presence from manifest text", () => {
    const root = makeRoot();
    writeFile(root, "_bmad/_config/manifest.yaml", "modules:\n  - core\n  - bmm\n  - bmb\n  - cis\n  - gds\n  - tea\n");

    const modules = scanOfficialBmadModules(root);

    expect(modules.every((entry) => entry.present)).toBe(true);
  });
});
