import * as fs from "node:fs";
import * as path from "node:path";
import type { BmadCatalogRow } from "./catalog.js";
import { dependencyTokens, findCatalogRow } from "./catalog.js";
import type { BmadPathConfig } from "./paths.js";
import { resolveOutputLocations, toProjectRelative } from "./paths.js";

export interface CompletionEvidence {
  row: BmadCatalogRow;
  complete: boolean;
  evidence: string[];
}

export interface Recommendation {
  row?: BmadCatalogRow;
  blockedBy: BmadCatalogRow[];
  optionalSamePhase: BmadCatalogRow[];
  requiredIncomplete: BmadCatalogRow[];
  completions: CompletionEvidence[];
}

const PHASE_ORDER = ["1-analysis", "2-planning", "3-solutioning", "4-implementation", "anytime"];
const IGNORE_DIRS = new Set([".git", "node_modules", ".pi", ".bmad-runtime"]);

function walkFiles(dir: string, limit = 1200): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    if (out.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith(".") && entry.name !== ".bmad-runtime") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function outputNeedles(outputs: string): string[] {
  return outputs
    .split(/[|;,]/g)
    .map((part) => normalize(part))
    .filter((part) => part.length > 0)
    .flatMap((part) => {
      const dashed = part.replaceAll(" ", "-");
      return dashed === part ? [part] : [part, dashed];
    });
}

function fileHasEvidence(file: string, needles: string[]): boolean {
  const rel = normalize(file);
  if (needles.some((needle) => rel.includes(needle))) return true;
  const ext = path.extname(file).toLowerCase();
  if (![".md", ".yaml", ".yml", ".json", ".txt", ".html"].includes(ext)) return false;
  try {
    const content = fs.readFileSync(file, "utf8").slice(0, 12000);
    const normalized = normalize(content);
    return needles.some((needle) => normalized.includes(needle));
  } catch {
    return false;
  }
}

export function scanCompletion(rows: BmadCatalogRow[], cfg: BmadPathConfig): CompletionEvidence[] {
  return rows.map((row) => {
    const locations = resolveOutputLocations(row.outputLocation, cfg);
    const needles = outputNeedles(row.outputs || row.displayName || row.skill);
    if (locations.length === 0 || needles.length === 0) return { row, complete: false, evidence: [] };

    const evidence: string[] = [];
    for (const location of locations) {
      const files = walkFiles(location);
      for (const file of files) {
        if (fileHasEvidence(file, needles)) evidence.push(toProjectRelative(cfg.projectRoot, file));
        if (evidence.length >= 5) break;
      }
      if (evidence.length >= 5) break;
    }
    return { row, complete: evidence.length > 0, evidence };
  });
}

function phaseRank(phase: string): number {
  const index = PHASE_ORDER.indexOf(phase);
  return index === -1 ? 999 : index;
}

function isComplete(completions: CompletionEvidence[], row: BmadCatalogRow): boolean {
  return completions.find((entry) => entry.row === row)?.complete ?? false;
}

export function recommendNext(rows: BmadCatalogRow[], cfg: BmadPathConfig): Recommendation {
  const completions = scanCompletion(rows, cfg);
  const requiredIncomplete = rows
    .filter((row) => row.required && !isComplete(completions, row))
    .sort((a, b) => phaseRank(a.phase) - phaseRank(b.phase));

  for (const row of requiredIncomplete) {
    const blockedBy = dependencyTokens(row)
      .map((token) => findCatalogRow(rows, token))
      .filter((candidate): candidate is BmadCatalogRow => Boolean(candidate))
      .filter((candidate) => candidate.required && !isComplete(completions, candidate));
    if (blockedBy.length === 0) {
      return {
        row,
        blockedBy: [],
        optionalSamePhase: rows.filter((candidate) => !candidate.required && candidate.phase === row.phase),
        requiredIncomplete,
        completions,
      };
    }
  }

  const fallback = requiredIncomplete[0];
  const blockedBy = fallback
    ? dependencyTokens(fallback)
        .map((token) => findCatalogRow(rows, token))
        .filter((candidate): candidate is BmadCatalogRow => Boolean(candidate))
        .filter((candidate) => candidate.required && !isComplete(completions, candidate))
    : [];

  return {
    row: fallback,
    blockedBy,
    optionalSamePhase: fallback ? rows.filter((candidate) => !candidate.required && candidate.phase === fallback.phase) : [],
    requiredIncomplete,
    completions,
  };
}

export function summarizeCompletion(completions: CompletionEvidence[]): { complete: number; total: number } {
  return {
    complete: completions.filter((entry) => entry.complete).length,
    total: completions.length,
  };
}
