import * as fs from "node:fs";
import * as path from "node:path";
import { loadPathConfig, toProjectRelative } from "./paths.js";

export interface RuntimeEvidencePayload {
  command: string;
  outcome: "ok" | "warning" | "degraded" | "blocked" | "error";
  summary: string;
  artifactKind?: ProjectOwnedArtifactKind;
  packageVersion?: string;
  touchedPaths?: string[];
  counts?: Record<string, number>;
  details?: unknown;
}

export type ProjectOwnedArtifactKind =
  | "workflow"
  | "gate"
  | "waiver"
  | "risk-acceptance"
  | "action-blocker"
  | "decision"
  | "evidence";

export interface ProjectOwnedArtifactPointer {
  kind: ProjectOwnedArtifactKind;
  relativePath: string;
  format: "markdown" | "yaml" | "json";
  projectOwned: true;
  contentStored: false;
}

export interface ProjectOwnedArtifactValidation {
  ok: boolean;
  checked: string[];
  missing: string[];
  outsideProject: string[];
  unsupportedFormat: string[];
  writeOccurred: false;
}

export interface RuntimeEvidenceResult {
  absolutePath: string;
  relativePath: string;
  runtimeHomePointer: ProjectOwnedArtifactPointer;
}

export interface SecretRedactionResult<T = unknown> {
  value: T;
  redactionCount: number;
  findings: string[];
}

const SECRET_TEXT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g },
  { label: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { label: "bearer-token", pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/gi },
  { label: "secret-assignment", pattern: /\b(api[_-]?key|apikey|token|secret|password|passwd|access[_-]?token|refresh[_-]?token|authorization|credential)\s*[:=]\s*([^\s,;]+)/gi },
];

const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|apikey|token|secret|password|passwd|access[_-]?token|refresh[_-]?token|authorization|credential)/i;

function redactSecretText(input: string): SecretRedactionResult<string> {
  let text = input;
  let redactionCount = 0;
  const findings: string[] = [];
  for (const { label, pattern } of SECRET_TEXT_PATTERNS) {
    text = text.replace(pattern, (...args: unknown[]) => {
      redactionCount += 1;
      findings.push(label);
      if (label === "bearer-token") return `${args[1] as string}[REDACTED:${label}]`;
      if (label === "secret-assignment") return `${args[1] as string}=[REDACTED:${label}]`;
      return `[REDACTED:${label}]`;
    });
  }
  return { value: text, redactionCount, findings };
}

function redactUnknown(value: unknown, sensitiveKey: string | undefined, depth: number): SecretRedactionResult {
  if (value === null || value === undefined) return { value, redactionCount: 0, findings: [] };
  if (sensitiveKey && typeof value !== "object") return { value: `[REDACTED:${sensitiveKey}]`, redactionCount: 1, findings: [sensitiveKey] };
  if (typeof value === "string") return redactSecretText(value);
  if (typeof value !== "object") return { value, redactionCount: 0, findings: [] };
  if (depth > 20) return { value: "[REDACTED:max-depth]", redactionCount: 1, findings: ["max-depth"] };

  if (Array.isArray(value)) {
    let redactionCount = 0;
    const findings: string[] = [];
    const next = value.map((item) => {
      const result = redactUnknown(item, undefined, depth + 1);
      redactionCount += result.redactionCount;
      findings.push(...result.findings);
      return result.value;
    });
    return { value: next, redactionCount, findings };
  }

  const out: Record<string, unknown> = {};
  let redactionCount = 0;
  const findings: string[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const sensitive = SENSITIVE_KEY_PATTERN.test(key) ? key.toLowerCase() : undefined;
    const result = redactUnknown(raw, sensitive, depth + 1);
    out[key] = result.value;
    redactionCount += result.redactionCount;
    findings.push(...result.findings);
  }
  return { value: out, redactionCount, findings };
}

export function redactSecrets<T = unknown>(value: T): SecretRedactionResult<T> {
  const result = redactUnknown(value, undefined, 0);
  return {
    value: result.value as T,
    redactionCount: result.redactionCount,
    findings: [...new Set(result.findings)],
  };
}

export function redactRuntimeEvidencePayload(payload: RuntimeEvidencePayload): SecretRedactionResult<RuntimeEvidencePayload> {
  return redactSecrets(payload);
}

function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (value === null || value === undefined || depth > 20) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectStrings(raw, out, depth + 1);
    }
  }
  return out;
}

export function detectCredentialRequirement(value: unknown): string[] {
  const text = collectStrings(value).join("\n");
  const reasons: string[] = [];
  const patterns = [
    /\b(?:missing|required|requires|need|needs|provide|enter|supply)\b.{0,80}\b(?:credential|credentials|api key|apikey|secret|token|password)\b/i,
    /\b(?:credential|credentials|api key|apikey|secret|token|password)\b.{0,80}\b(?:missing|required|needed|not configured)\b/i,
  ];
  for (const pattern of patterns) {
    if (pattern.test(text)) reasons.push("Credential/token/API key required; Owner approval is required before automation can continue.");
  }
  return [...new Set(reasons)];
}

function formatRedactedPayload(payload: RuntimeEvidencePayload): string {
  const redacted = redactRuntimeEvidencePayload(payload);
  const credentialReasons = detectCredentialRequirement(payload);
  const safePayload = redacted.value;
  const lines = [
    `## ${new Date().toISOString()} - ${safePayload.command}`,
    "",
    `- Outcome: ${safePayload.outcome}`,
    `- Summary: ${safePayload.summary}`,
    `- Artifact kind: ${safePayload.artifactKind ?? "workflow"}`,
  ];
  if (redacted.redactionCount > 0) {
    lines.push(`- Redactions: ${redacted.redactionCount}`);
    lines.push(`- Redaction classes: ${redacted.findings.join(", ") || "unknown"}`);
  }
  if (credentialReasons.length > 0) {
    lines.push("- Credential owner approval required: yes");
    lines.push("- Credential blocker reasons:");
    for (const reason of credentialReasons) lines.push(`  - ${reason}`);
  }
  if (safePayload.packageVersion) lines.push(`- Package version: ${safePayload.packageVersion}`);
  if (safePayload.touchedPaths?.length) {
    lines.push("- Touched paths:");
    for (const touchedPath of safePayload.touchedPaths) lines.push(`  - ${touchedPath}`);
  }
  if (safePayload.counts) {
    lines.push("- Counts:");
    for (const [key, value] of Object.entries(safePayload.counts)) lines.push(`  - ${key}: ${value}`);
  }
  if (safePayload.details !== undefined) {
    lines.push("", "```json", JSON.stringify(safePayload.details, null, 2), "```");
  }
  lines.push("");
  return lines.join("\n");
}

function projectRelative(cwd: string, absolutePath: string): string {
  return path.relative(cwd, absolutePath).replaceAll(path.sep, "/");
}

function withinProject(cwd: string, absolutePath: string): boolean {
  const rel = path.relative(cwd, absolutePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function artifactFormat(file: string): ProjectOwnedArtifactPointer["format"] | undefined {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".md") return "markdown";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".json") return "json";
  return undefined;
}

export function createRuntimeHomeEvidencePointer(
  cwd: string,
  artifactPath: string,
  kind: ProjectOwnedArtifactKind = "evidence",
): ProjectOwnedArtifactPointer {
  const absolutePath = path.isAbsolute(artifactPath) ? path.normalize(artifactPath) : path.resolve(cwd, artifactPath);
  const format = artifactFormat(absolutePath);
  if (!withinProject(cwd, absolutePath)) {
    throw new Error("Project-owned artifact pointer must stay inside the Project Workspace.");
  }
  if (!format) {
    throw new Error("Project-owned artifact pointer must reference Markdown, YAML, or JSON.");
  }
  return {
    kind,
    relativePath: projectRelative(cwd, absolutePath),
    format,
    projectOwned: true,
    contentStored: false,
  };
}

export function collectProjectOwnedArtifactReferences(text: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /(?:^|[\s`'"])((?:_bmad-output|_bmad|\.bmad-runtime|docs)\/[^\s`'"]+\.(?:md|ya?ml|json))/gim,
    /(?:^|[\s`'"])((?:_bmad-output|_bmad|\.bmad-runtime|docs)\\[^\s`'"]+\.(?:md|ya?ml|json))/gim,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const ref = match[1]?.trim().replaceAll("\\", "/");
      if (ref) refs.add(ref);
    }
  }
  return [...refs];
}

export function validateProjectOwnedArtifactReferences(cwd: string, refs: string[]): ProjectOwnedArtifactValidation {
  const checked: string[] = [];
  const missing: string[] = [];
  const outsideProject: string[] = [];
  const unsupportedFormat: string[] = [];
  for (const ref of refs) {
    if (!ref || /^check:|^approved-review:/i.test(ref)) continue;
    const absolutePath = path.isAbsolute(ref) ? path.normalize(ref) : path.resolve(cwd, ref);
    const normalizedRef = path.isAbsolute(ref) ? toProjectRelative(cwd, absolutePath) : ref.replaceAll("\\", "/");
    checked.push(normalizedRef);
    if (!withinProject(cwd, absolutePath)) {
      outsideProject.push(normalizedRef);
      continue;
    }
    if (!artifactFormat(absolutePath)) {
      unsupportedFormat.push(normalizedRef);
      continue;
    }
    if (!fs.existsSync(absolutePath)) missing.push(normalizedRef);
  }
  return {
    ok: missing.length === 0 && outsideProject.length === 0 && unsupportedFormat.length === 0,
    checked,
    missing,
    outsideProject,
    unsupportedFormat,
    writeOccurred: false,
  };
}

export function recordRuntimeEvidence(cwd: string, payload: RuntimeEvidencePayload): RuntimeEvidenceResult {
  const cfg = loadPathConfig(cwd);
  const evidenceDir = path.join(cfg.output_folder, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidenceFile = path.join(evidenceDir, "bmad-runtime-command-evidence.md");
  if (!fs.existsSync(evidenceFile)) {
    fs.writeFileSync(evidenceFile, "# BMAD Runtime Command Evidence\n\n", "utf8");
  }
  fs.appendFileSync(evidenceFile, formatRedactedPayload(payload), "utf8");
  return {
    absolutePath: evidenceFile,
    relativePath: toProjectRelative(cwd, evidenceFile),
    runtimeHomePointer: createRuntimeHomeEvidencePointer(cwd, evidenceFile, payload.artifactKind ?? "workflow"),
  };
}
