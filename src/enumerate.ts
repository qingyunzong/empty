import { SymbolGraph, type SymbolId } from "./graph.js";
import {
  analyzeImpact,
  type ChangeSet,
  type ImpactChain,
  type ImpactReport,
} from "./impact.js";

export interface EnumerateOptions {
  /** Safety bound; enumeration is only meant for small graphs. */
  maxPaths?: number;
}

const DEFAULT_MAX_PATHS = 100_000;

/**
 * Enumerate every simple reference chain from `entry` to `trigger`
 * (entry -> ... -> trigger). Intended for small graphs only; throws once the
 * number of discovered paths exceeds `maxPaths`.
 */
export function enumerateChains(
  entry: SymbolId,
  trigger: SymbolId,
  graph: SymbolGraph,
  options: EnumerateOptions = {},
): SymbolId[][] {
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const paths: SymbolId[][] = [];
  const stack: SymbolId[] = [entry];
  const onPath = new Set<SymbolId>([entry]);

  const visit = (current: SymbolId): void => {
    if (paths.length > maxPaths) {
      throw new RangeError(
        `enumerateChains: graph too large, exceeded ${maxPaths} paths`,
      );
    }
    if (current === trigger) {
      paths.push([...stack]);
      return;
    }
    for (const next of graph.referencesOf(current)) {
      if (onPath.has(next)) continue;
      onPath.add(next);
      stack.push(next);
      visit(next);
      stack.pop();
      onPath.delete(next);
    }
  };

  if (graph.has(entry) && graph.has(trigger)) visit(entry);
  return paths;
}

export interface VerificationMismatch {
  entry: SymbolId;
  reason: string;
  expected?: readonly SymbolId[];
  actual?: readonly SymbolId[];
}

export interface VerificationResult {
  ok: boolean;
  checkedPairs: number;
  mismatches: VerificationMismatch[];
}

function pickShortest(paths: SymbolId[][]): SymbolId[] | undefined {
  let best: SymbolId[] | undefined;
  for (const path of paths) {
    if (!best || path.length < best.length) best = path;
  }
  return best;
}

/**
 * Cross-check a report produced by `analyzeImpact` against exhaustive simple
 * path enumeration. For every (entry, trigger) pair the enumerated minimum
 * chain length must match the reported chain, and no affected entry may be
 * missing from the report. Only viable for small graphs.
 */
export function verifyReportByEnumeration(
  oldGraph: SymbolGraph,
  newGraph: SymbolGraph,
  changes: ChangeSet,
  report: ImpactReport = analyzeImpact(oldGraph, newGraph, changes),
  options: EnumerateOptions = {},
): VerificationResult {
  const mismatches: VerificationMismatch[] = [];
  let checkedPairs = 0;

  const expectedBest = new Map<SymbolId, SymbolId[]>();
  const consider = (
    graph: SymbolGraph,
    triggers: readonly SymbolId[] | undefined,
  ): void => {
    for (const trigger of triggers ?? []) {
      for (const entry of graph.publicEntries()) {
        const best = pickShortest(enumerateChains(entry, trigger, graph, options));
        if (!best) continue;
        checkedPairs += 1;
        const current = expectedBest.get(entry);
        if (!current || best.length < current.length) expectedBest.set(entry, best);
      }
    }
  };

  consider(newGraph, changes.changed);
  consider(oldGraph, changes.deleted);

  const reported = new Map<SymbolId, ImpactChain>();
  for (const impact of report.entries) reported.set(impact.entry, impact);

  for (const [entry, expected] of expectedBest) {
    const actual = reported.get(entry);
    if (!actual) {
      mismatches.push({ entry, reason: "missing affected entry", expected });
      continue;
    }
    if (actual.chain.length !== expected.length) {
      mismatches.push({
        entry,
        reason: `chain length ${actual.chain.length} != enumerated minimum ${expected.length}`,
        expected,
        actual: actual.chain,
      });
    }
  }
  for (const entry of reported.keys()) {
    if (!expectedBest.has(entry)) {
      mismatches.push({ entry, reason: "reported entry has no enumerated chain" });
    }
  }

  return { ok: mismatches.length === 0, checkedPairs, mismatches };
}
