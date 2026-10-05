/**
 * Rule-set minimization with exhaustive equivalence verification.
 *
 * minimizePolicy greedily removes rules: a rule is dropped when the remaining
 * rule set decides identically on EVERY point of an exhaustive attribute
 * space. The result is irredundant (1-minimal): no remaining rule can be
 * removed without changing some decision. It is not guaranteed to be a
 * globally minimum set, but every removal is proven safe by enumeration.
 *
 * Exhaustive attribute space:
 *   - boolean attribute  -> { true, false, <missing> }
 *   - string attribute   -> { each literal in the policy, a fresh "other"
 *                            string, <missing> }
 *   - rational attribute -> the policy's own thresholds partition the
 *     rational line; we sample every cell: t0-1, each threshold ti, the
 *     midpoint of each (ti, ti+1), tk+1, plus <missing>. Because conditions
 *     only compare against these thresholds, the decision is constant on
 *     each cell, so these samples are a faithful exhaustive check.
 *
 * Enumeration is only feasible for small policies; if the space exceeds
 * maxAssignments the minimizer refuses to guess and returns the original
 * policy with verified = false.
 */

import { type AttrValue, type Attrs, type Expr } from "./expr.js";
import {
  isRational,
  midRational,
  cmpRational,
  rational,
  rationalKey,
  type Rational,
} from "./rational.js";
import { decide, type Decision, type Policy, type Rule } from "./policy.js";

export class ExhaustionLimitError extends Error {
  readonly required: number;
  readonly limit: number;
  constructor(required: number, limit: number) {
    super(`exhaustive enumeration needs ${required} assignments, limit is ${limit}`);
    this.name = "ExhaustionLimitError";
    this.required = required;
    this.limit = limit;
  }
}

interface AttrProfile {
  readonly rationals: Map<string, Rational>;
  readonly strings: Set<string>;
  hasBoolean: boolean;
}

function walkExprs(policy: Policy, fn: (e: Expr) => void): void {
  const visit = (e: Expr): void => {
    fn(e);
    if (e.kind === "not") visit(e.arg);
    else if (e.kind === "and" || e.kind === "or") e.args.forEach(visit);
  };
  for (const r of policy.rules) visit(r.when);
}

function collectProfiles(policy: Policy): Map<string, AttrProfile> {
  const profiles = new Map<string, AttrProfile>();
  walkExprs(policy, (e) => {
    if (e.kind !== "cmp") return;
    let p = profiles.get(e.attr);
    if (!p) {
      p = { rationals: new Map(), strings: new Set(), hasBoolean: false };
      profiles.set(e.attr, p);
    }
    if (isRational(e.value)) p.rationals.set(rationalKey(e.value), e.value);
    else if (typeof e.value === "string") p.strings.add(e.value);
    else if (typeof e.value === "boolean") p.hasBoolean = true;
  });
  return profiles;
}

function rationalDomain(thresholds: readonly Rational[]): AttrValue[] {
  const sorted = [...thresholds].sort(cmpRational);
  const domain: AttrValue[] = [];
  if (sorted.length === 0) return domain;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  domain.push(rational(first.n - first.d, first.d)); // one step below t0
  for (let i = 0; i < sorted.length; i++) {
    domain.push(sorted[i]);
    if (i + 1 < sorted.length) domain.push(midRational(sorted[i], sorted[i + 1]));
  }
  domain.push(rational(last.n + last.d, last.d)); // one step above tk
  return domain;
}

function valueKey(v: AttrValue): string {
  if (isRational(v)) return `r:${rationalKey(v)}`;
  return `${typeof v}:${String(v)}`;
}

export interface AttrShape {
  readonly name: string;
  /** Sampled domain; the final entry is always `undefined` (attribute missing). */
  readonly domain: readonly (AttrValue | undefined)[];
}

/** Derive the exhaustive sample domain for every attribute used by the policy. */
export function collectShapes(policy: Policy): AttrShape[] {
  const profiles = collectProfiles(policy);
  const shapes: AttrShape[] = [];
  for (const [name, p] of [...profiles.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const values: AttrValue[] = [];
    const seen = new Set<string>();
    const push = (v: AttrValue): void => {
      const k = valueKey(v);
      if (!seen.has(k)) {
        seen.add(k);
        values.push(v);
      }
    };
    rationalDomain([...p.rationals.values()]).forEach(push);
    if (p.hasBoolean) {
      push(true);
      push(false);
    }
    for (const s of [...p.strings].sort()) push(s);
    if (p.strings.size > 0) {
      let other = "__other__";
      while (p.strings.has(other)) other += "_";
      push(other);
    }
    shapes.push({ name, domain: [...values, undefined] });
  }
  return shapes;
}

/** Cartesian product of all shape domains. Throws ExhaustionLimitError if too large. */
export function enumerateAssignments(
  shapes: readonly AttrShape[],
  maxAssignments: number,
): Attrs[] {
  let total = 1;
  for (const s of shapes) {
    total *= s.domain.length;
    if (total > maxAssignments) throw new ExhaustionLimitError(total, maxAssignments);
  }
  const out: Attrs[] = new Array(total);
  let count = 0;
  const acc: Record<string, AttrValue | undefined> = {};
  const go = (i: number): void => {
    if (i === shapes.length) {
      out[count++] = { ...acc };
      return;
    }
    const { name, domain } = shapes[i];
    for (const v of domain) {
      if (v === undefined) delete acc[name];
      else acc[name] = v;
      go(i + 1);
    }
    delete acc[name];
  };
  go(0);
  return out;
}

export function decisionVector(policy: Policy, assignments: readonly Attrs[]): Decision[] {
  return assignments.map((a) => decide(policy, a));
}

export function vectorsEqual(a: readonly Decision[], b: readonly Decision[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export interface MinimizeOptions {
  /** Safety cap on the exhaustive space size. Default 100_000. */
  readonly maxAssignments?: number;
}

export interface MinimizeResult {
  /** The minimized policy (identical reference to input when nothing changed). */
  readonly policy: Policy;
  readonly removed: readonly Rule[];
  /** True iff every kept/dropped decision was verified by exhaustive enumeration. */
  readonly verified: boolean;
  /** Number of attribute assignments checked per equivalence test. */
  readonly assignmentsChecked: number;
  readonly reason?: string;
}

const DEFAULT_MAX_ASSIGNMENTS = 100_000;

/**
 * Greedily produce a minimal (irredundant) rule set equivalent to `policy`.
 * Equivalence of every removal is proven by exhaustive attribute enumeration.
 */
export function minimizePolicy(policy: Policy, options: MinimizeOptions = {}): MinimizeResult {
  const max = options.maxAssignments ?? DEFAULT_MAX_ASSIGNMENTS;
  let assignments: Attrs[];
  try {
    assignments = enumerateAssignments(collectShapes(policy), max);
  } catch (err) {
    if (err instanceof ExhaustionLimitError) {
      return {
        policy,
        removed: [],
        verified: false,
        assignmentsChecked: 0,
        reason: err.message,
      };
    }
    throw err;
  }

  const baseline = decisionVector(policy, assignments);
  let kept: Rule[] = [...policy.rules];
  const removed: Rule[] = [];

  for (const r of policy.rules) {
    if (kept.length <= 1) break; // never minimize below a single rule silently
    const candidate = kept.filter((k) => k !== r);
    const trial: Policy = { name: policy.name, rules: candidate };
    if (vectorsEqual(decisionVector(trial, assignments), baseline)) {
      kept = candidate;
      removed.push(r);
    }
  }

  const minimized: Policy = { name: policy.name, rules: kept };
  const verified = vectorsEqual(decisionVector(minimized, assignments), baseline);
  return {
    policy: minimized,
    removed,
    verified,
    assignmentsChecked: assignments.length,
    ...(verified ? {} : { reason: "internal error: minimized policy diverges" }),
  };
}

export interface TableRow {
  readonly attrs: Attrs;
  readonly decision: Decision;
}

/** Full decision table of a policy over its exhaustive sample space (small policies only). */
export function exhaustiveTable(
  policy: Policy,
  maxAssignments: number = DEFAULT_MAX_ASSIGNMENTS,
): TableRow[] {
  const assignments = enumerateAssignments(collectShapes(policy), maxAssignments);
  return assignments.map((attrs) => ({ attrs, decision: decide(policy, attrs) }));
}
