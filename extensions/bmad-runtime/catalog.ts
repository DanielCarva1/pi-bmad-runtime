import * as fs from "node:fs";
import * as path from "node:path";

export interface BmadCatalogRow {
  module: string;
  skill: string;
  displayName: string;
  menuCode: string;
  description: string;
  action: string;
  args: string;
  phase: string;
  after: string;
  before: string;
  required: boolean;
  outputLocation: string;
  outputs: string;
}

const HEADER = [
  "module",
  "skill",
  "display-name",
  "menu-code",
  "description",
  "action",
  "args",
  "phase",
  "after",
  "before",
  "required",
  "output-location",
  "outputs",
];

export function getCatalogPath(cwd: string): string {
  return path.join(cwd, "_bmad", "_config", "bmad-help.csv");
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

export function parseBmadCatalog(csv: string): BmadCatalogRow[] {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0] ?? "");
  const headerLooksRight = HEADER.every((h, i) => header[i] === h);
  const dataLines = headerLooksRight ? lines.slice(1) : lines;

  return dataLines
    .map(parseCsvLine)
    .filter((cells) => cells.length >= 2)
    .map((cells) => ({
      module: cells[0] ?? "",
      skill: cells[1] ?? "",
      displayName: cells[2] ?? "",
      menuCode: cells[3] ?? "",
      description: cells[4] ?? "",
      action: cells[5] ?? "",
      args: cells[6] ?? "",
      phase: cells[7] ?? "anytime",
      after: cells[8] ?? "",
      before: cells[9] ?? "",
      required: String(cells[10] ?? "").toLowerCase() === "true",
      outputLocation: cells[11] ?? "",
      outputs: cells[12] ?? "",
    }))
    .filter((row) => row.skill && row.skill !== "_meta");
}

export function loadBmadCatalog(cwd: string): { path: string; rows: BmadCatalogRow[]; exists: boolean; error?: string } {
  const catalogPath = getCatalogPath(cwd);
  if (!fs.existsSync(catalogPath)) return { path: catalogPath, rows: [], exists: false };
  try {
    return { path: catalogPath, rows: parseBmadCatalog(fs.readFileSync(catalogPath, "utf8")), exists: true };
  } catch (error) {
    return { path: catalogPath, rows: [], exists: true, error: error instanceof Error ? error.message : String(error) };
  }
}

export function findCatalogRow(rows: BmadCatalogRow[], token: string): BmadCatalogRow | undefined {
  const normalized = token.trim().toLowerCase();
  return rows.find((row) => {
    return (
      row.menuCode.toLowerCase() === normalized ||
      row.skill.toLowerCase() === normalized ||
      row.displayName.toLowerCase() === normalized
    );
  });
}

export function dependencyTokens(row: BmadCatalogRow): string[] {
  return row.after
    .split(/[|;,]/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(":")[0] ?? part);
}
