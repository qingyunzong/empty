export type Effect = "allow" | "deny";

export interface Candidate {
  id: string;
  cost: number;
  effect: Effect;
  matches: string[]; // sample ids this rule applies to
}

export interface Sample {
  id: string;
  expect: Effect;
}

export interface Problem {
  candidates: Candidate[];
  samples: Sample[];
}

export const MAX_CANDIDATES = 18;

function isEffect(value: unknown): value is Effect {
  return value === "allow" || value === "deny";
}

export function validateProblem(raw: unknown): { problem: Problem | null; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { problem: null, errors: ['input must be a JSON object with "candidates" and "samples"'] };
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.candidates)) errors.push('"candidates" must be an array');
  if (!Array.isArray(obj.samples)) errors.push('"samples" must be an array');
  if (errors.length > 0) return { problem: null, errors };

  const candidates: Candidate[] = [];
  const candidateIds = new Set<string>();
  for (const [i, item] of (obj.candidates as unknown[]).entries()) {
    const where = `candidates[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    const c = item as Record<string, unknown>;
    if (typeof c.id !== "string" || c.id.length === 0) {
      errors.push(`${where}: "id" must be a non-empty string`);
      continue;
    }
    if (candidateIds.has(c.id)) {
      errors.push(`${where}: duplicate candidate id "${c.id}"`);
      continue;
    }
    candidateIds.add(c.id);
    if (typeof c.cost !== "number" || !Number.isFinite(c.cost) || c.cost < 0) {
      errors.push(`${where} ("${c.id}"): "cost" must be a finite number >= 0`);
      continue;
    }
    if (!isEffect(c.effect)) {
      errors.push(`${where} ("${c.id}"): "effect" must be "allow" or "deny"`);
      continue;
    }
    if (!Array.isArray(c.matches) || c.matches.some((m) => typeof m !== "string")) {
      errors.push(`${where} ("${c.id}"): "matches" must be an array of sample id strings`);
      continue;
    }
    candidates.push({ id: c.id, cost: c.cost, effect: c.effect, matches: [...new Set(c.matches as string[])] });
  }
  if (candidates.length > MAX_CANDIDATES) {
    errors.push(`at most ${MAX_CANDIDATES} candidates allowed, got ${candidates.length}`);
  }

  const samples: Sample[] = [];
  const sampleIds = new Set<string>();
  for (const [i, item] of (obj.samples as unknown[]).entries()) {
    const where = `samples[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    const s = item as Record<string, unknown>;
    if (typeof s.id !== "string" || s.id.length === 0) {
      errors.push(`${where}: "id" must be a non-empty string`);
      continue;
    }
    if (sampleIds.has(s.id)) {
      errors.push(`${where}: duplicate sample id "${s.id}"`);
      continue;
    }
    sampleIds.add(s.id);
    if (!isEffect(s.expect)) {
      errors.push(`${where} ("${s.id}"): "expect" must be "allow" or "deny"`);
      continue;
    }
    samples.push({ id: s.id, expect: s.expect });
  }

  for (const c of candidates) {
    for (const m of c.matches) {
      if (!sampleIds.has(m)) errors.push(`candidate "${c.id}" matches unknown sample "${m}"`);
    }
  }

  if (errors.length > 0) return { problem: null, errors };
  return { problem: { candidates, samples }, errors: [] };
}

// ---- Decision semantics ---------------------------------------------------
// For a chosen subset S of candidates and a sample s:
//   1. If any selected rule matching s has effect "deny"  -> deny (deny wins).
//   2. Else if any selected rule matching s has effect "allow" -> allow.
//   3. Else (no selected rule matches s) -> default deny.

export interface MatchedRule {
  id: string;
  effect: Effect;
  cost: number;
}

export interface SampleEvidence {
  sampleId: string;
  expected: Effect;
  actual: Effect;
  matchedRules: MatchedRule[];
  decidedBy: string[];
  reason: string;
}

export function evaluateSample(
  problem: Problem,
  selected: ReadonlySet<number>,
  sampleIndex: number,
): SampleEvidence {
  const sample = problem.samples[sampleIndex]!;
  const matchedRules: MatchedRule[] = [];
  for (const i of selected) {
    const c = problem.candidates[i]!;
    if (c.matches.includes(sample.id)) {
      matchedRules.push({ id: c.id, effect: c.effect, cost: c.cost });
    }
  }
  const denyIds = matchedRules.filter((r) => r.effect === "deny").map((r) => r.id);
  const allowIds = matchedRules.filter((r) => r.effect === "allow").map((r) => r.id);
  if (denyIds.length > 0) {
    const reason =
      allowIds.length > 0
        ? `deny rule(s) [${denyIds.join(", ")}] override allow rule(s) [${allowIds.join(", ")}] (deny priority)`
        : `deny rule(s) [${denyIds.join(", ")}] matched`;
    return { sampleId: sample.id, expected: sample.expect, actual: "deny", matchedRules, decidedBy: denyIds, reason };
  }
  if (allowIds.length > 0) {
    const reason = `allow rule(s) [${allowIds.join(", ")}] matched and no deny rule matched`;
    return { sampleId: sample.id, expected: sample.expect, actual: "allow", matchedRules, decidedBy: allowIds, reason };
  }
  return {
    sampleId: sample.id,
    expected: sample.expect,
    actual: "deny",
    matchedRules,
    decidedBy: [],
    reason: "no selected rule matches this sample (default deny)",
  };
}

export function buildEvidence(problem: Problem, selectedIndices: readonly number[]): SampleEvidence[] {
  const selected = new Set(selectedIndices);
  return problem.samples.map((_, i) => evaluateSample(problem, selected, i));
}

// ---- Subset ordering (deterministic tie-break) -----------------------------
// Primary: lower total cost. Then: fewer rules. Then: lexicographic id list.

export interface SubsetScore {
  cost: number;
  ids: string[]; // sorted ascending
}

export function compareSubsets(a: SubsetScore, b: SubsetScore): number {
  if (a.cost !== b.cost) return a.cost - b.cost;
  if (a.ids.length !== b.ids.length) return a.ids.length - b.ids.length;
  for (let i = 0; i < a.ids.length; i++) {
    const x = a.ids[i]!;
    const y = b.ids[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---- Bitmask view of a problem (samples fit in a BigInt mask) --------------

export interface MaskedProblem {
  problem: Problem;
  allowMask: bigint[]; // per candidate: samples it would allow
  denyMask: bigint[]; // per candidate: samples it would deny
  expectAllowMask: bigint;
  expectDenyMask: bigint;
  costs: number[];
  ids: string[];
}

export function toMasked(problem: Problem): MaskedProblem {
  const index = new Map(problem.samples.map((s, i) => [s.id, i]));
  const allowMask: bigint[] = [];
  const denyMask: bigint[] = [];
  for (const c of problem.candidates) {
    let allow = 0n;
    let deny = 0n;
    for (const m of c.matches) {
      const bit = 1n << BigInt(index.get(m)!);
      if (c.effect === "allow") allow |= bit;
      else deny |= bit;
    }
    allowMask.push(allow);
    denyMask.push(deny);
  }
  let expectAllowMask = 0n;
  problem.samples.forEach((s, i) => {
    if (s.expect === "allow") expectAllowMask |= 1n << BigInt(i);
  });
  const allSamplesMask = (1n << BigInt(problem.samples.length)) - 1n;
  return {
    problem,
    allowMask,
    denyMask,
    expectAllowMask,
    expectDenyMask: allSamplesMask & ~expectAllowMask,
    costs: problem.candidates.map((c) => c.cost),
    ids: problem.candidates.map((c) => c.id),
  };
}
