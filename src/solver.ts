import { decide, matchGlob, Problem, Rule, Sample } from "./model.js";

export interface SolveResult {
  feasible: boolean;
  cost: number;
  mask: number;
  selected: Rule[];
  explored: number;
}

export interface SampleEvidence {
  sampleId: string;
  expected: "allow" | "deny";
  decision: "allow" | "deny";
  ok: boolean;
  matched: { id: string; action: "allow" | "deny"; cost: number }[];
}

interface Compiled {
  rules: Rule[];
  samples: Sample[];
  allowMask: number[];
  denyMask: number[];
}

function compile(problem: Problem): Compiled {
  const { candidates, samples } = problem;
  const allowMask = new Array<number>(samples.length).fill(0);
  const denyMask = new Array<number>(samples.length).fill(0);
  for (let s = 0; s < samples.length; s++) {
    const req = samples[s].request;
    for (let i = 0; i < candidates.length; i++) {
      const rule = candidates[i];
      const hit =
        matchField(rule.match.subject, req.subject) &&
        matchField(rule.match.op, req.op) &&
        matchField(rule.match.resource, req.resource);
      if (hit) {
        if (rule.action === "allow") allowMask[s] |= 1 << i;
        else denyMask[s] |= 1 << i;
      }
    }
  }
  return { rules: candidates, samples, allowMask, denyMask };
}

function matchField(pattern: string, value: string): boolean {
  return matchGlob(pattern, value);
}

function decisionOf(mask: number, c: Compiled, s: number): "allow" | "deny" {
  if ((mask & c.denyMask[s]) !== 0) return "deny";
  if ((mask & c.allowMask[s]) !== 0) return "allow";
  return "deny";
}

function satisfiesAll(mask: number, c: Compiled): boolean {
  for (let s = 0; s < c.samples.length; s++) {
    if (decisionOf(mask, c, s) !== c.samples[s].expect) return false;
  }
  return true;
}

function popcount(x: number): number {
  let count = 0;
  while (x !== 0) {
    x &= x - 1;
    count++;
  }
  return count;
}

function better(
  costA: number,
  countA: number,
  maskA: number,
  costB: number,
  countB: number,
  maskB: number,
): boolean {
  if (costA !== costB) return costA < costB;
  if (countA !== countB) return countA < countB;
  return maskA < maskB;
}

function toResult(
  feasible: boolean,
  cost: number,
  mask: number,
  rules: Rule[],
  explored: number,
): SolveResult {
  const selected: Rule[] = [];
  for (let i = 0; i < rules.length; i++) {
    if ((mask & (1 << i)) !== 0) selected.push(rules[i]);
  }
  return { feasible, cost, mask, selected, explored };
}

export function solveBruteForce(problem: Problem): SolveResult {
  const c = compile(problem);
  const n = c.rules.length;
  const total = 1 << n;
  const costs = c.rules.map((r) => r.cost);
  let bestCost = -1;
  let bestCount = 0;
  let bestMask = 0;
  for (let mask = 0; mask < total; mask++) {
    if (!satisfiesAll(mask, c)) continue;
    let cost = 0;
    for (let i = 0; i < n; i++) {
      if ((mask & (1 << i)) !== 0) cost += costs[i];
    }
    const count = popcount(mask);
    if (
      bestCost === -1 ||
      better(cost, count, mask, bestCost, bestCount, bestMask)
    ) {
      bestCost = cost;
      bestCount = count;
      bestMask = mask;
    }
  }
  if (bestCost === -1) return toResult(false, -1, 0, c.rules, total);
  return toResult(true, bestCost, bestMask, c.rules, total);
}

export function solveBranchAndBound(problem: Problem): SolveResult {
  const c = compile(problem);
  const n = c.rules.length;
  const costs = c.rules.map((r) => r.cost);
  let bestCost = -1;
  let bestCount = 0;
  let bestMask = 0;
  let explored = 0;

  const visit = (index: number, mask: number, cost: number, count: number): void => {
    if (bestCost !== -1 && !better(cost, count, mask, bestCost, bestCount, bestMask)) {
      if (cost > bestCost) return;
      if (cost === bestCost && count >= bestCount) return;
    }
    for (let s = 0; s < c.samples.length; s++) {
      if (
        c.samples[s].expect === "allow" &&
        (mask & c.denyMask[s]) !== 0
      ) {
        return;
      }
    }
    if (index === n) {
      explored++;
      if (satisfiesAll(mask, c)) {
        if (
          bestCost === -1 ||
          better(cost, count, mask, bestCost, bestCount, bestMask)
        ) {
          bestCost = cost;
          bestCount = count;
          bestMask = mask;
        }
      }
      return;
    }
    visit(index + 1, mask, cost, count);
    visit(index + 1, mask | (1 << index), cost + costs[index], count + 1);
  };
  visit(0, 0, 0, 0);

  if (bestCost === -1) return toResult(false, -1, 0, c.rules, explored);
  return toResult(true, bestCost, bestMask, c.rules, explored);
}

export function buildEvidence(problem: Problem, selected: Rule[]): SampleEvidence[] {
  return problem.samples.map((sample) => {
    const { decision, matched } = decide(selected, sample.request);
    return {
      sampleId: sample.id,
      expected: sample.expect,
      decision,
      ok: decision === sample.expect,
      matched: matched.map((rule) => ({
        id: rule.id,
        action: rule.action,
        cost: rule.cost,
      })),
    };
  });
}
