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

const CANONICAL_ARTIFACTS = [
  { id: "prd", label: "Canonical PRD", rel: "planning-artifacts/prd.md", requiredForReadiness: true },
  { id: "ux", label: "UX specification", rel: "planning-artifacts/ux-design-specification.md", requiredForReadiness: true },
  { id: "phase2-grill", label: "Phase 2 grill", rel: "planning-artifacts/phase-2-grill-with-docs-2026-05-29.md", requiredForReadiness: true },
  { id: "architecture", label: "Architecture", rel: "planning-artifacts/architecture.md", requiredForReadiness: true },
  { id: "epics", label: "Epics and stories", rel: "planning-artifacts/epics.md", requiredForReadiness: true },
  { id: "readiness", label: "Implementation readiness", rel: "planning-artifacts/implementation-readiness-report-2026-05-29.md", requiredForReadiness: true },
  { id: "sprint-status", label: "Sprint status", rel: "implementation-artifacts/sprint-status.yaml", requiredForReadiness: false },
];

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
