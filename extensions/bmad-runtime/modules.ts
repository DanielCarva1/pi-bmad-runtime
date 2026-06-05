import * as fs from "node:fs";
import * as path from "node:path";
import { toProjectRelative } from "./paths.js";

export const OFFICIAL_BMAD_MODULES = ["core", "bmm", "bmb", "cis", "gds", "tea"] as const;
export type OfficialBmadModule = (typeof OFFICIAL_BMAD_MODULES)[number];

export interface OfficialModuleStatus {
  module: OfficialBmadModule;
  present: boolean;
  evidence: string[];
  hint?: string;
}

function manifestMentions(manifestText: string, moduleId: string): boolean {
  const escaped = moduleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`, "i").test(manifestText);
}

export function scanOfficialBmadModules(cwd: string): OfficialModuleStatus[] {
  const manifestPath = path.join(cwd, "_bmad", "_config", "manifest.yaml");
  const manifestText = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : "";

  return OFFICIAL_BMAD_MODULES.map((moduleId) => {
    const candidateFiles = [
      path.join(cwd, "_bmad", moduleId, "config.yaml"),
      path.join(cwd, "_bmad", moduleId, "module-help.csv"),
    ];
    const evidence = candidateFiles.filter((file) => fs.existsSync(file)).map((file) => toProjectRelative(cwd, file));
    if (manifestText && manifestMentions(manifestText, moduleId)) evidence.push(toProjectRelative(cwd, manifestPath));
    const present = evidence.length > 0;
    return {
      module: moduleId,
      present,
      evidence: [...new Set(evidence)],
      hint: present
        ? undefined
        : "Official BMAD Suite module missing. Use guided BMAD reconcile/install preview and confirm active baseline changes unless project policy marks the reconcile safe.",
    };
  });
}
