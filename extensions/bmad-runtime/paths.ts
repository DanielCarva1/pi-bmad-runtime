import * as fs from "node:fs";
import * as path from "node:path";

export interface BmadPathConfig {
  projectRoot: string;
  output_folder: string;
  planning_artifacts: string;
  implementation_artifacts: string;
  project_knowledge: string;
  [key: string]: string;
}

const DEFAULTS = {
  output_folder: "_bmad-output",
  planning_artifacts: "{project-root}/_bmad-output/planning-artifacts",
  implementation_artifacts: "{project-root}/_bmad-output/implementation-artifacts",
  project_knowledge: "docs",
};

function parseSimpleYaml(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!key) continue;
    let value = match[2]?.trim() ?? "";
    value = value.replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

function resolveTemplate(cwd: string, raw: string): string {
  let value = raw.replaceAll("{project-root}", cwd);
  value = value.replaceAll("{output_folder}", DEFAULTS.output_folder);
  if (!path.isAbsolute(value)) value = path.join(cwd, value);
  return path.normalize(value);
}

export function loadPathConfig(cwd: string): BmadPathConfig {
  const bmm = parseSimpleYaml(path.join(cwd, "_bmad", "bmm", "config.yaml"));
  const core = parseSimpleYaml(path.join(cwd, "_bmad", "core", "config.yaml"));
  const merged = { ...DEFAULTS, ...core, ...bmm };

  const cfg: BmadPathConfig = {
    projectRoot: cwd,
    output_folder: resolveTemplate(cwd, merged.output_folder ?? DEFAULTS.output_folder),
    planning_artifacts: resolveTemplate(cwd, merged.planning_artifacts ?? DEFAULTS.planning_artifacts),
    implementation_artifacts: resolveTemplate(cwd, merged.implementation_artifacts ?? DEFAULTS.implementation_artifacts),
    project_knowledge: resolveTemplate(cwd, merged.project_knowledge ?? DEFAULTS.project_knowledge),
  };

  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === "string" && !(key in cfg)) cfg[key] = resolveTemplate(cwd, value);
  }

  // BMad manifests use both spellings in the wild.
  cfg["project-knowledge"] = cfg.project_knowledge;
  cfg["planning_artifacts"] = cfg.planning_artifacts;
  cfg["implementation_artifacts"] = cfg.implementation_artifacts;
  cfg["output_folder"] = cfg.output_folder;

  return cfg;
}

export function resolveOutputLocations(raw: string, cfg: BmadPathConfig): string[] {
  if (!raw.trim()) return [];
  return raw
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => cfg[part] ?? resolveTemplate(cfg.projectRoot, part))
    .filter((value, index, arr) => arr.indexOf(value) === index);
}

export function toProjectRelative(cwd: string, absolutePath: string): string {
  const rel = path.relative(cwd, absolutePath).replaceAll(path.sep, "/");
  return rel.startsWith("..") ? absolutePath : rel;
}
