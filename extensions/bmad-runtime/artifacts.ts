import * as fs from "node:fs";
import * as path from "node:path";
import type { BmadPathConfig } from "./paths.js";
import { toProjectRelative } from "./paths.js";

export type ArtifactStatus = "missing" | "seed" | "draft" | "canonical" | "validated" | "blocked" | "waived";

export interface ArtifactRegistryEntry {
  id: string;
  label: string;
  path: string;
  status: ArtifactStatus;
  requiredForReadiness: boolean;
}

export interface ArtifactCleanupEvidence {
  resultCaptured?: boolean;
  changedFilesListed?: boolean;
  checksRecorded?: boolean;
  evidenceReferenced?: boolean;
  nextStatusUpdated?: boolean;
}

export type ArtifactCleanupDecision =
  | "protected-canonical"
  | "ephemeral-candidate-allowed"
  | "ephemeral-candidate-blocked"
  | "unmanaged-blocked";

export interface ArtifactCleanupClassification {
  path: string;
  decision: ArtifactCleanupDecision;
  canDeleteOrArchive: boolean;
  reason: string;
  missingEvidence: string[];
}

const CANONICAL_ARTIFACTS = [
  { id: "prd", label: "Canonical PRD", rel: "planning-artifacts/prd.md", requiredForReadiness: true },
  { id: "ux", label: "UX specification", rel: "planning-artifacts/ux-design-specification.md", requiredForReadiness: true },
  { id: "phase2-grill", label: "Phase 2 grill", rel: "planning-artifacts/phase-2-grill-with-docs-2026-05-29.md", requiredForReadiness: true },
  { id: "architecture", label: "Architecture", rel: "planning-artifacts/architecture.md", requiredForReadiness: true },
  { id: "epics", label: "Epics and stories", rel: "planning-artifacts/epics.md", requiredForReadiness: true },
  { id: "readiness", label: "Implementation readiness", rel: "planning-artifacts/implementation-readiness-report-2026-05-29.md", requiredForReadiness: true },
  { id: "sprint-status", label: "Sprint status", rel: "implementation-artifacts/sprint-status.yaml", requiredForReadiness: false },
];

const PROTECTED_CANONICAL_PATTERNS = [
  /^\.bmad-runtime\//,
  /^_bmad\//,
  /^_bmad-output\/planning-artifacts\//,
  /^_bmad-output\/evidence\//,
  /^_bmad-output\/context\//,
  /^_bmad-output\/decision-logs\//,
  /^_bmad-output\/implementation-artifacts\/sprint-status\.ya?ml$/,
  /^_bmad-output\/implementation-artifacts\/\d+-\d+-[^/]+\.md$/,
  /^_bmad-output\/implementation-artifacts\/v\d+(?:\.\d+)?\//,
];

const EPHEMERAL_TASK_PACKET_PATTERNS = [
  /^_bmad-output\/task-packets\//,
  /^_bmad-output\/work-packets\//,
  /^_bmad-output\/agent-work\//,
  /^_bmad-output\/tmp\//,
  /^docs\/task-packets\//,
  /^docs\/work-packets\//,
  /^\.bmad-runtime\/tmp\//,
];

function normalizeArtifactPath(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
}

export function isProtectedCanonicalArtifactPath(filePath: string): boolean {
  const normalized = normalizeArtifactPath(filePath);
  return PROTECTED_CANONICAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isEphemeralTaskPacketPath(filePath: string): boolean {
  const normalized = normalizeArtifactPath(filePath);
  return EPHEMERAL_TASK_PACKET_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function classifyArtifactCleanupPath(filePath: string, evidence: ArtifactCleanupEvidence = {}): ArtifactCleanupClassification {
  const normalized = normalizeArtifactPath(filePath);
  if (isProtectedCanonicalArtifactPath(normalized)) {
    return {
      path: normalized,
      decision: "protected-canonical",
      canDeleteOrArchive: false,
      reason: "Canonical runtime/planning/story/sprint/evidence artifacts are protected and are not ephemeral task packets.",
      missingEvidence: [],
    };
  }

  if (!isEphemeralTaskPacketPath(normalized)) {
    return {
      path: normalized,
      decision: "unmanaged-blocked",
      canDeleteOrArchive: false,
      reason: "Path is not in a recognized ephemeral task-packet location.",
      missingEvidence: [],
    };
  }

  const required = [
    ["resultCaptured", "result captured"],
    ["changedFilesListed", "changed files listed"],
    ["checksRecorded", "checks recorded"],
    ["evidenceReferenced", "evidence referenced"],
    ["nextStatusUpdated", "next status updated"],
  ] as const;
  const missingEvidence = required.filter(([key]) => !evidence[key]).map(([, label]) => label);
  return {
    path: normalized,
    decision: missingEvidence.length === 0 ? "ephemeral-candidate-allowed" : "ephemeral-candidate-blocked",
    canDeleteOrArchive: missingEvidence.length === 0,
    reason: missingEvidence.length === 0
      ? "Ephemeral task packet cleanup is allowed because result, files, checks, evidence and next status are captured."
      : "Ephemeral task packet cleanup is blocked until completion evidence is captured.",
    missingEvidence,
  };
}

export function formatArtifactCleanupPolicy(): string {
  return [
    "Artifact cleanup policy:",
    "- Protected canonical artifacts are never task-packet cleanup targets: runtime state, baseline, registry, planning artifacts, stories, sprint status, evidence and handoffs.",
    "- Ephemeral candidates must live in task/work packet locations such as _bmad-output/task-packets/ or docs/task-packets/.",
    "- Delete/archive is allowed only after result, changed files, checks, evidence reference and next status are captured.",
  ].join("\n");
}

function statusFromContent(file: string): ArtifactStatus {
  if (!fs.existsSync(file)) return "missing";
  const basename = path.basename(file).toLowerCase();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8").slice(0, 20000).toLowerCase();
  } catch {
    return "draft";
  }
  if (text.includes("waived") || text.includes("readinessdecision: \"waiver") || text.includes("readinessdecision: waiver")) return "waived";
  if (text.includes("blocked") || text.includes("not ready")) return "blocked";
  if (basename.includes("readiness") && (/readinessdecision:\s*"?pass"?/i.test(text) || text.includes("overall status:** ready"))) return "validated";
  if (text.includes("validation") && (text.includes("pass") || text.includes("passed") || text.includes("ready"))) return "validated";
  if (text.includes("status: \"complete") || text.includes("status: complete") || text.includes("workflowtype:")) return "canonical";
  if (basename.includes("seed")) return "seed";
  return "draft";
}

export function scanArtifactRegistry(cfg: BmadPathConfig): ArtifactRegistryEntry[] {
  const outputRoot = cfg.output_folder;
  return CANONICAL_ARTIFACTS.map((artifact) => {
    const absolute = path.join(outputRoot, artifact.rel);
    return {
      id: artifact.id,
      label: artifact.label,
      path: toProjectRelative(cfg.projectRoot, absolute),
      status: statusFromContent(absolute),
      requiredForReadiness: artifact.requiredForReadiness,
    };
  });
}

export function formatArtifactRegistry(entries: ArtifactRegistryEntry[]): string {
  if (entries.length === 0) return "Artifact registry: no known artifacts configured.";
  return [
    "Artifact registry:",
    ...entries.map((entry) => `- [${entry.status}] ${entry.label}: ${entry.path}${entry.requiredForReadiness ? " (readiness)" : ""}`),
  ].join("\n");
}
