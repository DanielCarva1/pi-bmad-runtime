import * as fs from "node:fs";
import * as path from "node:path";

export type AdapterStatus = "available" | "missing" | "degraded" | "not-required";
export type AdapterDecision = "reuse" | "fork" | "build" | "ignore" | "undecided";

export interface PackageAdapter {
  name: string;
  role: string;
  status: AdapterStatus;
  decision: AdapterDecision;
  hint?: string;
}

export const RECOMMENDED_ADAPTERS: Array<Omit<PackageAdapter, "status" | "decision" | "hint">> = [
  { name: "pi-goal-x", role: "long-running goals and scoped objective memory" },
  { name: "@gotgenes/pi-subagents", role: "real Pi subagent delegation" },
  { name: "pi-safety-modes", role: "supplemental safety mode signaling" },
  { name: "pi-show-diffs", role: "diff/review presentation" },
  { name: "pi-resource-center", role: "package/resource discovery" },
  { name: "pi-studio", role: "artifact review workspace" },
  { name: "@plannotator/pi-extension", role: "plan and gate annotation" },
  { name: "pi-powerline-footer", role: "persistent TUI status chrome" },
];

export function readPackageSpecs(cwd: string): string[] {
  const settingsFile = path.join(cwd, ".pi", "settings.json");
  if (!fs.existsSync(settingsFile)) return [];
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as { packages?: unknown[] };
    return (settings.packages ?? [])
      .map((entry) => typeof entry === "string" ? entry : entry && typeof entry === "object" ? String((entry as { source?: unknown }).source ?? "") : "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function packageConfigured(specs: string[], name: string): boolean {
  return specs.some((spec) => spec === name || spec.includes(`:${name}`) || spec.includes(name));
}

export function scanPackageAdapters(cwd: string): PackageAdapter[] {
  const specs = readPackageSpecs(cwd);
  return RECOMMENDED_ADAPTERS.map((adapter) => {
    const available = packageConfigured(specs, adapter.name);
    return {
      ...adapter,
      status: available ? "available" : "degraded",
      decision: available ? "reuse" : "undecided",
      hint: available ? undefined : "Optional adapter missing; BMAD core remains canonical in text/TUI degraded mode.",
    };
  });
}

export function formatPackageAdapters(adapters: PackageAdapter[]): string {
  return [
    "Package adapter registry:",
    ...adapters.map((adapter) => `- [${adapter.status}] ${adapter.name} — ${adapter.role}; decision=${adapter.decision}${adapter.hint ? `; ${adapter.hint}` : ""}`),
  ].join("\n");
}
