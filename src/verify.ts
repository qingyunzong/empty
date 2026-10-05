import { Rational, type RationalInput } from './rational.js';
import type { AttrValue, Attrs } from './expr.js';
import { F, T, U, type Tri } from './trilean.js';
import {
  decide,
  evaluate,
  type Decision,
  type Policy,
  type RuleResult,
} from './policy.js';

/** Candidate values per attribute; "missing" (undefined) is always included. */
export type AttrDomains = Readonly<Record<string, readonly (boolean | RationalInput)[]>>;

const TRIS: readonly Tri[] = [T, F, U];

/** Enumerates every attribute assignment: each attribute takes each domain
 *  value plus "missing". Only for small policies (cartesian product). */
export function* enumerateAssignments(domains: AttrDomains): Generator<Attrs> {
  const names = Object.keys(domains);
  const choices: (AttrValue | undefined)[][] = names.map((name) => [
    undefined,
    ...domains[name]!.map((v) => (typeof v === 'boolean' ? v : Rational.of(v))),
  ]);
  const assignment: Record<string, AttrValue | undefined> = {};
  function* walk(i: number): Generator<Attrs> {
    if (i === names.length) {
      yield { ...assignment };
      return;
    }
    for (const value of choices[i]!) {
      assignment[names[i]!] = value;
      yield* walk(i + 1);
    }
  }
  yield* walk(0);
}

function* completions(count: number): Generator<Tri[]> {
  const out: Tri[] = new Array<Tri>(count);
  function* walk(i: number): Generator<Tri[]> {
    if (i === count) {
      yield [...out];
      return;
    }
    for (const tri of TRIS) {
      out[i] = tri;
      yield* walk(i + 1);
    }
  }
  yield* walk(0);
}

/**
 * Brute-force decisiveness check: holding the results of `subsetIds` fixed,
 * does the decision stay the same for every possible result (T/F/U) of every
 * other rule?
 */
export function isDecisive(
  ruleResults: readonly RuleResult[],
  subsetIds: ReadonlySet<string>,
  decision: Decision,
): boolean {
  const free = ruleResults.filter((r) => !subsetIds.has(r.id));
  const fixed = ruleResults.filter((r) => subsetIds.has(r.id));
  for (const combo of completions(free.length)) {
    const trial: RuleResult[] = [
      ...fixed,
      ...free.map((r, i) => ({ ...r, value: combo[i]! })),
    ];
    if (decide(trial) !== decision) return false;
  }
  return true;
}

/** Finds a minimum-cardinality decisive subset by exhaustive enumeration. */
export function bruteForceMinimalDecisive(
  ruleResults: readonly RuleResult[],
  decision: Decision,
): string[] {
  const ids = ruleResults.map((r) => r.id);
  for (let size = 0; size <= ids.length; size++) {
    const picked: string[] = [];
    function* combos(start: number): Generator<string[]> {
      if (picked.length === size) {
        yield [...picked];
        return;
      }
      for (let i = start; i < ids.length; i++) {
        picked.push(ids[i]!);
        yield* combos(i + 1);
        picked.pop();
      }
    }
    for (const subset of combos(0)) {
      if (isDecisive(ruleResults, new Set(subset), decision)) return subset;
    }
  }
  throw new Error('unreachable: the full set is always decisive');
}

export interface VerifyReport {
  readonly assignmentsChecked: number;
  readonly failures: readonly string[];
}

function describe(attrs: Attrs): string {
  const parts = Object.entries(attrs).map(([k, v]) =>
    `${k}=${v === undefined ? '<missing>' : String(v)}`,
  );
  return `{${parts.join(', ')}}`;
}

/**
 * Exhaustively cross-checks a small policy over all attribute assignments:
 *  1. evaluation is total and deterministic;
 *  2. the decision agrees with the aggregation semantics;
 *  3. the reported decisive set is actually decisive (completion brute force);
 *  4. its cardinality equals the brute-forced minimum.
 */
export function verifyPolicyExhaustive(
  policy: Policy,
  domains: AttrDomains,
  maxAssignments = 100_000,
): VerifyReport {
  const failures: string[] = [];
  let checked = 0;
  for (const attrs of enumerateAssignments(domains)) {
    checked++;
    if (checked > maxAssignments) {
      failures.push(`assignment budget ${maxAssignments} exceeded; policy too large to exhaust`);
      break;
    }
    const where = describe(attrs);
    let first;
    try {
      first = evaluate(policy, attrs);
    } catch (err) {
      failures.push(`${where}: evaluation threw: ${String(err)}`);
      continue;
    }
    const second = evaluate(policy, attrs);
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      failures.push(`${where}: non-deterministic evaluation`);
    }
    if (first.decision !== decide(first.ruleResults)) {
      failures.push(`${where}: decision disagrees with aggregation semantics`);
    }
    const subset = new Set(first.decisiveRuleIds);
    if (!isDecisive(first.ruleResults, subset, first.decision)) {
      failures.push(`${where}: reported decisive set is not decisive`);
    }
    const minimal = bruteForceMinimalDecisive(first.ruleResults, first.decision);
    if (minimal.length !== first.decisiveRuleIds.length) {
      failures.push(
        `${where}: decisive set size ${first.decisiveRuleIds.length} ` +
          `exceeds brute-forced minimum ${minimal.length}`,
      );
    }
  }
  return { assignmentsChecked: checked, failures };
}
