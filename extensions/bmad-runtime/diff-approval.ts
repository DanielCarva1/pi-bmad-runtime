import * as fs from "node:fs";
import * as path from "node:path";

export type DiffApprovalMode = "not-installed" | "safe" | "bypass" | "blocking" | "unknown";

export interface DiffApprovalPolicy {
  packageName: "pi-show-diffs";
  configured: boolean;
  mode: DiffApprovalMode;
  blocking: boolean;
  bypassAllowed: boolean;
  source?: string;
  evidence: string[];
  blockers: string[];
}

interface PackageEntryInfo {
  source: string;
  fields: Record<string, unknown>;
}

function readSettings(cwd: string): unknown[] {
  const file = path.join(cwd, ".pi", "settings.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { packages?: unknown };
    return Array.isArray(parsed.packages) ? parsed.packages : [];
  } catch {
    return [];
  }
}

function packageEntryInfo(entry: unknown): PackageEntryInfo | undefined {
  if (typeof entry === "string") return { source: entry, fields: {} };
  if (!entry || typeof entry !== "object") return undefined;
  const fields = entry as Record<string, unknown>;
  const source = String(fields.source ?? fields.name ?? fields.package ?? fields.id ?? "");
  const nested = ["settings", "config", "options"]
    .map((name) => fields[name])
    .filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value));
  return source ? { source, fields: Object.assign({}, fields, ...nested) } : undefined;
}

function isPiShowDiffs(entry: PackageEntryInfo): boolean {
  return entry.source === "pi-show-diffs" || entry.source.includes("pi-show-diffs");
}

function boolField(fields: Record<string, unknown>, names: string[]): boolean | undefined {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function stringField(fields: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return undefined;
}

function policy(mode: DiffApprovalMode, source: string, evidence: string[], blockers: string[] = []): DiffApprovalPolicy {
  const blocking = mode === "blocking" || mode === "unknown";
  return {
    packageName: "pi-show-diffs",
    configured: true,
    mode,
    blocking,
    bypassAllowed: mode === "safe" || mode === "bypass",
    source,
    evidence,
    blockers,
  };
}

function classifyPiShowDiffs(entry: PackageEntryInfo): DiffApprovalPolicy {
  const { source, fields } = entry;
  const enabled = boolField(fields, ["enabled", "active"]);
  const autoApprove = boolField(fields, ["autoApprove", "auto_approve", "autoApproval", "auto_approval"]);
  const bypass = boolField(fields, ["bypassApproval", "bypass_approval", "bypassPhase34", "phase34Bypass", "phase3And4Bypass"]);
  const blocking = boolField(fields, ["blocking", "requiresApproval", "requires_approval", "manualApproval", "manual_approval"]);
  const mode = stringField(fields, ["mode", "approvalMode", "approval_mode", "diffMode", "diff_mode"]);
  const approval = stringField(fields, ["approval", "approvalPolicy", "approval_policy"]);

  if (enabled === false) {
    return policy("safe", source, ["pi-show-diffs is configured but disabled; no mandatory diff approval UI can block automation."]);
  }
  if (autoApprove === true || bypass === true) {
    return policy("bypass", source, ["pi-show-diffs is configured with auto-approval/bypass for Phase 3/4 automation."]);
  }
  if (blocking === true) {
    return policy("blocking", source, ["pi-show-diffs explicitly requires blocking/manual approval."], ["Disable pi-show-diffs or configure auto-approval/bypass before Phase 3/4 automation."]);
  }
  if (blocking === false) {
    return policy("safe", source, ["pi-show-diffs explicitly does not require blocking/manual approval."]);
  }

  if (mode && ["disabled", "safe", "non-blocking", "nonblocking", "preview-only", "readonly", "read-only"].includes(mode)) {
    return policy("safe", source, [`pi-show-diffs mode '${mode}' does not require mandatory approval.`]);
  }
  if (mode && ["auto", "auto-approve", "autoapprove", "bypass"].includes(mode)) {
    return policy("bypass", source, [`pi-show-diffs mode '${mode}' permits automation without mandatory approval.`]);
  }
  if (mode && ["blocking", "manual", "approval", "approve", "review"].includes(mode)) {
    return policy("blocking", source, [`pi-show-diffs mode '${mode}' is blocking/manual.`], ["Configure pi-show-diffs as disabled, non-blocking, auto-approve or bypass for Phase 3/4 automation."]);
  }
  if (approval && ["none", "disabled", "auto", "auto-approve", "bypass"].includes(approval)) {
    return policy("bypass", source, [`pi-show-diffs approval '${approval}' permits automation without mandatory approval.`]);
  }
  if (approval && ["required", "manual", "blocking", "prompt"].includes(approval)) {
    return policy("blocking", source, [`pi-show-diffs approval '${approval}' is blocking/manual.`], ["Configure diff approval as none/auto/bypass before Phase 3/4 automation."]);
  }

  return policy(
    "unknown",
    source,
    ["pi-show-diffs is configured but no non-blocking, disabled, auto-approve or bypass setting was found."],
    ["Diff approval mode is unknown and may require a mandatory prompt/modal; configure bypass/safe mode or remove pi-show-diffs before Phase 3/4 automation."],
  );
}

export function evaluateDiffApprovalPolicy(cwd: string): DiffApprovalPolicy {
  const matches = readSettings(cwd)
    .map(packageEntryInfo)
    .filter((entry): entry is PackageEntryInfo => !!entry && isPiShowDiffs(entry))
    .map(classifyPiShowDiffs);

  if (matches.length === 0) {
    return {
      packageName: "pi-show-diffs",
      configured: false,
      mode: "not-installed",
      blocking: false,
      bypassAllowed: true,
      evidence: ["pi-show-diffs is not configured; no diff approval UI can block automation."],
      blockers: [],
    };
  }

  return matches.find((item) => item.blocking) ?? matches[0]!;
}

export function formatDiffApprovalPolicy(policy: DiffApprovalPolicy): string {
  return [
    "Diff approval policy:",
    `- package: ${policy.packageName}`,
    `- configured: ${policy.configured ? "yes" : "no"}`,
    `- mode: ${policy.mode}`,
    `- blocking: ${policy.blocking ? "yes" : "no"}`,
    `- bypass allowed: ${policy.bypassAllowed ? "yes" : "no"}`,
    ...(policy.source ? [`- source: ${policy.source}`] : []),
    "Evidence:",
    ...policy.evidence.map((item) => `- ${item}`),
    "Blockers:",
    ...(policy.blockers.length ? policy.blockers.map((item) => `- ${item}`) : ["- none"]),
  ].join("\n");
}
