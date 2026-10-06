import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { makeFold, type Mapping, type Rename } from "./model.js";

export class PreflightError extends Error {
  readonly conflicts: string[];
  constructor(conflicts: string[]) {
    super(`preflight failed with ${conflicts.length} conflict(s):\n${conflicts.map((c) => `  - ${c}`).join("\n")}`);
    this.name = "PreflightError";
    this.conflicts = conflicts;
  }
}

function parseRenames(raw: unknown): Rename[] {
  if (Array.isArray(raw)) {
    return raw.map((entry, i) => {
      if (typeof entry !== "object" || entry === null) throw new Error(`renames[${i}] must be an object`);
      const rec = entry as Record<string, unknown>;
      if (typeof rec.from !== "string" || typeof rec.to !== "string") {
        throw new Error(`renames[${i}] must have string "from" and "to"`);
      }
      return { from: rec.from, to: rec.to };
    });
  }
  if (typeof raw === "object" && raw !== null) {
    return Object.entries(raw as Record<string, unknown>).map(([from, to]) => {
      if (typeof to !== "string") throw new Error(`renames[${JSON.stringify(from)}] must map to a string`);
      return { from, to };
    });
  }
  throw new Error(`"renames" must be an array of {from,to} or an object of from->to`);
}

export function parseMapping(jsonText: string): Mapping {
  const doc = JSON.parse(jsonText) as Record<string, unknown>;
  if (typeof doc !== "object" || doc === null) throw new Error("mapping file must contain a JSON object");
  const caseFold = doc.caseFold === undefined ? true : doc.caseFold;
  if (typeof caseFold !== "boolean") throw new Error(`"caseFold" must be a boolean`);
  return { caseFold, renames: parseRenames(doc.renames) };
}

function insideDir(dir: string, rel: string): string | null {
  if (isAbsolute(rel)) return null;
  const abs = resolve(dir, normalize(rel));
  if (abs !== dir && !abs.startsWith(dir + sep)) return null;
  return abs;
}

function listFolded(dirPath: string, fold: (s: string) => string): Set<string> {
  const out = new Set<string>();
  try {
    for (const entry of readdirSync(dirPath)) out.add(fold(entry));
  } catch {
    // missing dir handled by caller checks
  }
  return out;
}

export interface ValidatedMapping {
  caseFold: boolean;
  renames: Rename[];
  dirNames: Set<string>;
}

export function preflight(dir: string, mapping: Mapping): ValidatedMapping {
  const fold = makeFold(mapping.caseFold);
  const conflicts: string[] = [];
  const renames: Rename[] = [];

  const seenSources = new Map<string, string>();
  const seenTargets = new Map<string, string>();
  for (const r of mapping.renames) {
    const fromAbs = insideDir(dir, r.from);
    const toAbs = insideDir(dir, r.to);
    if (fromAbs === null) {
      conflicts.push(`source ${JSON.stringify(r.from)} escapes the working directory`);
      continue;
    }
    if (toAbs === null) {
      conflicts.push(`target ${JSON.stringify(r.to)} escapes the working directory`);
      continue;
    }
    if (fromAbs === toAbs) {
      conflicts.push(`no-op rename ${JSON.stringify(r.from)} -> ${JSON.stringify(r.to)}`);
      continue;
    }
    const fromKey = fold(fromAbs);
    const toKey = fold(toAbs);
    const prevSource = seenSources.get(fromKey);
    if (prevSource !== undefined) {
      conflicts.push(`duplicate source: ${JSON.stringify(prevSource)} and ${JSON.stringify(r.from)} collide`);
    } else {
      seenSources.set(fromKey, r.from);
    }
    const prevTarget = seenTargets.get(toKey);
    if (prevTarget !== undefined) {
      conflicts.push(`duplicate target: ${JSON.stringify(prevTarget)} and ${JSON.stringify(r.to)} collide`);
    } else {
      seenTargets.set(toKey, r.to);
    }
    renames.push({ from: fromAbs, to: toAbs });
  }

  const sourceKeys = new Set(seenSources.keys());
  const dirCache = new Map<string, Set<string>>();
  const namesIn = (dirPath: string): Set<string> => {
    let names = dirCache.get(dirPath);
    if (!names) {
      names = listFolded(dirPath, fold);
      dirCache.set(dirPath, names);
    }
    return names;
  };

  for (const r of renames) {
    const fromKey = fold(r.from);
    const toKey = fold(r.to);
    if (!namesIn(dirname(r.from)).has(fold(basename(r.from)))) {
      conflicts.push(`source missing on disk: ${JSON.stringify(r.from)}`);
    }
    const targetParent = dirname(r.to);
    if (!existsSync(targetParent) || !statSync(targetParent).isDirectory()) {
      conflicts.push(`target directory missing: ${JSON.stringify(dirname(r.to))}`);
      continue;
    }
    const targetTaken = namesIn(targetParent).has(fold(basename(r.to)));
    if (targetTaken && !sourceKeys.has(toKey) && toKey !== fromKey) {
      conflicts.push(`target ${JSON.stringify(r.to)} already exists and is not part of the batch`);
    }
  }

  if (conflicts.length > 0) throw new PreflightError(conflicts);

  const dirNames = new Set<string>();
  for (const names of dirCache.values()) {
    for (const n of names) dirNames.add(n);
  }
  return { caseFold: mapping.caseFold, renames, dirNames };
}
