// Independent enumeration cross-check.
//
// This module deliberately re-implements evaluation and enumeration from
// scratch (odometer-style loops instead of the recursive generators in
// order.ts, direct extension enumeration instead of the three-valued rule
// walk in evaluate.ts) so that a bug in the primary search is likely to
// show up as a disagreement here.

import type { SearchResult } from "./search.js";
import type { Assignment, Condition, Effect, Policy, Spec, Value } from "./types.js";

export const DEFAULT_VERIFY_LIMIT = 2_000_000;

export interface VerifyReport {
  status: "passed" | "failed" | "skipped";
  checks: string[];
  failures: string[];
  notes: string[];
}

class LimitExceeded extends Error {}

function matches(cond: Condition, assignment: Assignment): boolean {
  const actual = assignment.get(cond.attr);
  switch (cond.kind) {
    case "eq":
      return actual === cond.value;
    case "ne":
      return actual !== cond.value;
    case "in":
      return cond.values.includes(actual as Value);
  }
}

/** Independent total-assignment evaluator: plain first-match scan. */
export function decide(policy: Policy, assignment: Assignment): Effect {
  for (const rule of policy.rules) {
    let hit = true;
    for (const cond of rule.conditions) {
      if (!assignment.has(cond.attr) || !matches(cond, assignment)) {
        hit = false;
        break;
      }
    }
    if (hit) return rule.effect;
  }
  return policy.defaultEffect;
}

/** Enumerate all total extensions of a (partial) base assignment, odometer-style. */
export function* enumerateExtensions(spec: Spec, base: Assignment): Generator<Map<string, Value>> {
  const open = spec.attributes.filter((a) => !base.has(a.name));
  const positions = new Array<number>(open.length).fill(0);
  for (;;) {
    const assignment = new Map<string, Value>(base);
    for (let i = 0; i < open.length; i++) assignment.set(open[i]!.name, open[i]!.domain[positions[i]!]!);
    yield assignment;
    let i = open.length - 1;
    while (i >= 0) {
      positions[i] = positions[i]! + 1;
      if (positions[i]! < open[i]!.domain.length) break;
      positions[i] = 0;
      i--;
    }
    if (i < 0) return;
  }
}

/** Effects a policy can take over all extensions of `base`, by explicit enumeration. */
export function effectsByExtension(spec: Spec, policy: Policy, base: Assignment, limit: number): Set<Effect> {
  const out = new Set<Effect>();
  let nodes = 0;
  for (const total of enumerateExtensions(spec, base)) {
    if (++nodes > limit) throw new LimitExceeded();
    out.add(decide(policy, total));
    if (out.size === 2) {
      // Both effects already reachable; keep counting is unnecessary for the set,
      // but we must still respect the caller's limit bookkeeping, so stop early.
      break;
    }
  }
  return out;
}

function isWitnessIndependent(spec: Spec, assignment: Assignment, limit: number): boolean {
  const a = effectsByExtension(spec, spec.policies[0], assignment, limit);
  const b = effectsByExtension(spec, spec.policies[1], assignment, limit);
  if (a.size !== 1 || b.size !== 1) return false;
  return [...a][0] !== [...b][0];
}

/** Independent re-implementation of the canonical enumeration order (odometer-based). */
export function* enumerateCanonical(spec: Spec): Generator<Map<string, Value>> {
  const attrs = spec.attributes;
  const n = attrs.length;
  for (let k = 0; k <= n; k++) {
    const combo: number[] = [];
    for (let i = 0; i < k; i++) combo.push(i);
    for (;;) {
      const positions = new Array<number>(k).fill(0);
      for (;;) {
        const assignment = new Map<string, Value>();
        for (let i = 0; i < k; i++) assignment.set(attrs[combo[i]!]!.name, attrs[combo[i]!]!.domain[positions[i]!]!);
        yield assignment;
        let i = k - 1;
        while (i >= 0) {
          positions[i] = positions[i]! + 1;
          if (positions[i]! < attrs[combo[i]!]!.domain.length) break;
          positions[i] = 0;
          i--;
        }
        if (i < 0) break;
      }
      // next combination in lexicographic order
      let i = k - 1;
      while (i >= 0 && combo[i] === n - k + i) i--;
      if (i < 0) break;
      combo[i] = combo[i]! + 1;
      for (let j = i + 1; j < k; j++) combo[j] = combo[j - 1]! + 1;
    }
  }
}

function sameAssignment(a: Assignment, b: Assignment): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

function totalSpace(spec: Spec): bigint {
  return spec.attributes.reduce((acc, attr) => acc * BigInt(attr.domain.length), 1n);
}

function partialSpace(spec: Spec): bigint {
  return spec.attributes.reduce((acc, attr) => acc * BigInt(attr.domain.length + 1), 1n);
}

/** Run the independent cross-check appropriate for the search verdict. */
export function verifyResult(spec: Spec, result: SearchResult, limit: number = DEFAULT_VERIFY_LIMIT): VerifyReport {
  const checks: string[] = [];
  const failures: string[] = [];
  const notes: string[] = [];
  try {
    if (result.verdict === "DIFFER") verifyDiffer(spec, result, limit, checks, notes);
    else if (result.verdict === "EQUIVALENT") verifyEquivalent(spec, result, limit, checks, notes);
    else verifyUndecided(spec, result, limit, checks, notes);
  } catch (err) {
    if (err instanceof LimitExceeded) {
      notes.push(`enumeration limit of ${limit} nodes exceeded; remaining checks skipped`);
    } else if (err instanceof VerifyFailure) {
      failures.push(err.message);
    } else {
      throw err;
    }
  }
  const status = failures.length > 0 ? "failed" : notes.length > 0 ? "skipped" : "passed";
  return { status, checks, failures, notes };
}

class VerifyFailure extends Error {}

function assertVerify(ok: boolean, message: string): asserts ok {
  if (!ok) throw new VerifyFailure(message);
}

function verifyDiffer(spec: Spec, result: SearchResult, limit: number, checks: string[], notes: string[]): void {
  const witness = result.witness!;
  const decisions = result.decisions!;
  for (const [name, value] of witness) {
    const attr = spec.attributes.find((a) => a.name === name);
    assertVerify(attr !== undefined, `witness specifies undeclared attribute "${name}"`);
    assertVerify(attr.domain.includes(value), `witness value for "${name}" is outside its domain`);
  }
  checks.push("witness is well-formed (declared attributes, in-domain values)");

  const a = effectsByExtension(spec, spec.policies[0], witness, limit);
  const b = effectsByExtension(spec, spec.policies[1], witness, limit);
  assertVerify(a.size === 1 && [...a][0] === decisions[0], `policy "${spec.policies[0].name}" is not constantly ${decisions[0]} on every extension of the witness`);
  assertVerify(b.size === 1 && [...b][0] === decisions[1], `policy "${spec.policies[1].name}" is not constantly ${decisions[1]} on every extension of the witness`);
  checks.push("both policies are determined and disagree on every total extension of the witness");

  // Minimality: every candidate before the witness in canonical order must be a non-witness.
  let smaller = 0;
  for (const candidate of enumerateCanonical(spec)) {
    if (sameAssignment(candidate, witness)) break;
    if (smaller >= limit) throw new LimitExceeded();
    assertVerify(!isWitnessIndependent(spec, candidate, limit), `smaller candidate ${JSON.stringify([...candidate])} is also a witness`);
    smaller++;
  }
  assertVerify(smaller === result.checked - 1, `witness rank mismatch: ${smaller} smaller candidates vs checked=${result.checked}`);
  checks.push(`minimality: all ${smaller} earlier candidates in canonical order are non-witnesses`);
  void notes;
}

function verifyEquivalent(spec: Spec, result: SearchResult, limit: number, checks: string[], notes: string[]): void {
  assertVerify(result.checked.toString() === partialSpace(spec).toString(), `checked=${result.checked} but partial space is ${partialSpace(spec)}`);
  checks.push(`primary search covered the whole partial space (${result.checked} candidates)`);
  let totals = 0n;
  for (const total of enumerateExtensions(spec, new Map())) {
    if (totals >= BigInt(limit)) throw new LimitExceeded();
    const a = decide(spec.policies[0], total);
    const b = decide(spec.policies[1], total);
    assertVerify(a === b, `policies disagree on total assignment ${JSON.stringify([...total])}`);
    totals++;
  }
  assertVerify(totals.toString() === totalSpace(spec).toString(), `enumerated ${totals} total assignments, expected ${totalSpace(spec)}`);
  checks.push(`all ${totals} total assignments give identical decisions`);
  void notes;
}

function verifyUndecided(spec: Spec, result: SearchResult, limit: number, checks: string[], notes: string[]): void {
  let count = 0;
  let hasMore = false;
  for (const candidate of enumerateCanonical(spec)) {
    if (count >= result.checked) {
      hasMore = true;
      break;
    }
    if (count >= limit) throw new LimitExceeded();
    assertVerify(!isWitnessIndependent(spec, candidate, limit), `candidate #${count + 1} is a witness but the primary search missed it`);
    count++;
  }
  assertVerify(count === result.checked, `independent enumeration produced ${count} candidates, primary checked ${result.checked}`);
  assertVerify(hasMore, "budget stopped the search but the space was actually exhausted");
  checks.push(`re-enumerated the ${count} checked candidates: none is a witness, and the space continues beyond the budget`);
  void notes;
}
