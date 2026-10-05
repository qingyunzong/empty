import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { MappingFile, Plan, PlanStep, RenameEntry } from "./types.js";

/** Raised when preflight finds any conflict; the whole batch is rejected. */
export class PreflightError extends Error {
  readonly conflicts: string[];
  constructor(conflicts: string[]) {
    super(`preflight failed, batch rejected:\n${conflicts.map((c) => `  - ${c}`).join("\n")}`);
    this.name = "PreflightError";
    this.conflicts = conflicts;
  }
}

function fold(name: string, caseFold: boolean): string {
  return caseFold ? name.toLowerCase() : name;
}

function validateRelative(name: string, problems: string[]): void {
  if (name.length === 0) problems.push("empty path in mapping");
  if (path.isAbsolute(name)) problems.push(`absolute path not allowed: ${name}`);
  if (name.split("/").includes("..")) problems.push(`path escapes directory: ${name}`);
}

interface Edge {
  actualFrom: string;
  actualTo: string;
  foldedTo: string;
}

/**
 * Validate the mapping against the on-disk state of `dir` and produce an
 * executable plan. Any conflict rejects the whole batch (PreflightError).
 * Comparison of names follows the case-fold rule from the input.
 */
export function buildPlan(dir: string, mapping: MappingFile, caseFold: boolean): Plan {
  const problems: string[] = [];
  const raw = mapping.renames ?? [];
  if (!Array.isArray(raw)) throw new PreflightError(["mapping.renames must be an array"]);

  const renames: RenameEntry[] = [];
  for (const entry of raw) {
    validateRelative(entry.from, problems);
    validateRelative(entry.to, problems);
    if (entry.from === entry.to) continue; // exact no-op
    renames.push({ from: entry.from, to: entry.to });
  }

  const foldedFroms = new Map<string, string>();
  const foldedTos = new Map<string, string>();
  for (const r of renames) {
    const ff = fold(r.from, caseFold);
    const ft = fold(r.to, caseFold);
    const prevFrom = foldedFroms.get(ff);
    if (prevFrom !== undefined) problems.push(`duplicate source: "${prevFrom}" and "${r.from}"`);
    else foldedFroms.set(ff, r.from);
    const prevTo = foldedTos.get(ft);
    if (prevTo !== undefined) problems.push(`duplicate target: "${prevTo}" and "${r.to}"`);
    else foldedTos.set(ft, r.to);
  }

  // Snapshot the directory: folded name -> actual on-disk name.
  const dirEntries = fs.readdirSync(dir);
  const foldedDir = new Map<string, string>();
  for (const name of dirEntries) {
    const f = fold(name, caseFold);
    if (!foldedDir.has(f)) foldedDir.set(f, name);
  }

  // Resolve every source to the actual on-disk name (case-fold per input rule).
  const effectiveFrom = new Map<string, string>(); // mapping from -> actual name
  for (const r of renames) {
    const f = fold(r.from, caseFold);
    const actual = foldedDir.get(f);
    if (actual === undefined) {
      problems.push(`source not found: "${r.from}"`);
    } else {
      effectiveFrom.set(r.from, actual);
    }
  }

  // Every target must be free, or occupied only by a file that is itself
  // being renamed away. Anything else is an unknown file -> conflict.
  const foldedSourceSet = new Set<string>();
  for (const actual of effectiveFrom.values()) foldedSourceSet.add(fold(actual, caseFold));
  for (const r of renames) {
    const ft = fold(r.to, caseFold);
    const occupant = foldedDir.get(ft);
    if (occupant !== undefined && !foldedSourceSet.has(fold(occupant, caseFold))) {
      problems.push(`target "${r.to}" collides with existing file "${occupant}" that is not part of the batch`);
    }
  }

  if (problems.length > 0) throw new PreflightError(problems);

  // Build edges keyed by folded source name.
  const edges = new Map<string, Edge>();
  for (const r of renames) {
    const actual = effectiveFrom.get(r.from)!;
    edges.set(fold(actual, caseFold), { actualFrom: actual, actualTo: r.to, foldedTo: fold(r.to, caseFold) });
  }

  const steps: PlanStep[] = [];
  const remaining = new Set(edges.keys());
  const usedNames = new Set<string>();
  for (const name of dirEntries) usedNames.add(fold(name, caseFold));
  for (const r of renames) usedNames.add(fold(r.to, caseFold));

  // Chains first: start at nodes whose folded name is nobody's target.
  const targetedNodes = new Set<string>();
  for (const e of edges.values()) if (remaining.has(e.foldedTo)) targetedNodes.add(e.foldedTo);

  const followChain = (head: string): Edge[] => {
    const chain: Edge[] = [];
    let node: string | undefined = head;
    while (node !== undefined && remaining.has(node)) {
      remaining.delete(node);
      const edge: Edge = edges.get(node)!;
      chain.push(edge);
      node = edge.foldedTo;
    }
    return chain;
  };

  for (const node of [...remaining]) {
    if (!targetedNodes.has(node)) {
      const chain = followChain(node);
      for (let i = chain.length - 1; i >= 0; i--) {
        const e = chain[i]!;
        steps.push({ from: e.actualFrom, to: e.actualTo, temp: false });
      }
    }
  }

  // Remaining nodes form pure cycles; break each with a temporary name.
  let tempCounter = 0;
  while (remaining.size > 0) {
    const start = remaining.values().next().value as string;
    const cycle = followChain(start);
    let tempName: string;
    do {
      tempName = `.photo-rename.tmp.${randomUUID().slice(0, 8)}.${tempCounter++}`;
    } while (usedNames.has(fold(tempName, caseFold)));
    usedNames.add(fold(tempName, caseFold));

    const first = cycle[0]!;
    steps.push({ from: first.actualFrom, to: tempName, temp: true });
    for (let i = cycle.length - 1; i >= 1; i--) {
      const e = cycle[i]!;
      steps.push({ from: e.actualFrom, to: e.actualTo, temp: false });
    }
    steps.push({ from: tempName, to: first.actualTo, temp: false });
  }

  return { caseFold, renames, steps };
}

/** Inverse mapping: swap from/to and reverse order. */
export function invertRenames(renames: RenameEntry[]): RenameEntry[] {
  return renames.map((r) => ({ from: r.to, to: r.from })).reverse();
}

export function joinIn(dir: string, name: string): string {
  return path.join(dir, name);
}
