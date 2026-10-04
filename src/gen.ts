/**
 * Seeded random trace generator for acceptance testing.
 *
 * Invariants enforced so generated traces are always replayable and the
 * exhaustive value-based minimality check is meaningful:
 *  - every data read refers to a variable already written at control
 *    depth 0, so the full trace never reads an unwritten variable;
 *  - branch bodies only write already-defined data variables;
 *  - every write to a variable uses a value never written to it before,
 *    so a subset falling back to an older write always sees a different
 *    value;
 *  - computes strictly vary in each operand (no zero operand to `mul`,
 *    no `sub(x, x)`), so a changed operand always changes the result;
 *  - every compute takes at least one frozen operand (a variable written
 *    exactly once and never rewritten), so at most one operand can ever
 *    diverge in a subtrace and two divergences cannot cancel each other;
 *  - `if` conditions read dedicated flag variables, each written exactly
 *    once by a const at depth 0, so a subset can never keep a predicate
 *    while silently changing its truth value.
 *
 * The generator simulates the exact taken path while emitting, so
 * candidate compute results are checked against the values the full
 * replay will actually produce.
 */

import { TraceEvent } from "./trace";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DATA_VARS = ["a", "b", "c", "d"];
const FLAG_VARS = ["f0", "f1", "f2", "f3"];
const FNS = ["add", "sub", "mul"] as const;

export interface Generated {
  trace: TraceEvent[];
  target: number;
}

export function genTrace(seed: number, maxEvents = 20): Generated {
  const rnd = mulberry32(seed);
  const trace: TraceEvent[] = [];
  const defined = new Set<string>(); // data vars written at depth 0
  const frozen = new Set<string>(); // write-once vars, never rewritten
  const usedValues = new Map<string, Set<number>>();
  const current = new Map<string, number>(); // exact values on the taken path
  const availableFlags: string[] = []; // written at depth 0, not yet used by an if
  const writeCounts = new Map<string, number>();
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
  const pickDefined = (): string => pick([...defined]);
  const remaining = (): number => maxEvents - 1 - trace.length; // reserve target output
  const valueUsed = (v: string, val: number): boolean => usedValues.get(v)?.has(val) ?? false;
  const recordWrite = (v: string, val: number): void => {
    if (!usedValues.has(v)) usedValues.set(v, new Set());
    usedValues.get(v)!.add(val);
    current.set(v, val);
    writeCounts.set(v, (writeCounts.get(v) ?? 0) + 1);
  };

  const tryConst = (depth: number): boolean => {
    const pool = (depth === 0 ? DATA_VARS : [...defined]).filter((v) => !frozen.has(v));
    if (pool.length === 0) return false;
    const out = pick(pool);
    for (let attempt = 0; attempt < 10; attempt++) {
      const value = Math.floor(rnd() * 10);
      if (!valueUsed(out, value)) {
        trace.push({ op: "const", out, value });
        recordWrite(out, value);
        if (depth === 0) {
          if (!defined.has(out) && rnd() < 0.5) frozen.add(out); // fresh write-once var
          defined.add(out);
        }
        return true;
      }
    }
    return false;
  };

  const tryCompute = (depth: number): boolean => {
    if (defined.size < 1 || frozen.size < 1) return false;
    const pool = (depth === 0 ? DATA_VARS : [...defined]).filter((v) => !frozen.has(v));
    if (pool.length === 0) return false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const out = pick(pool);
      const fn = pick(FNS);
      // one frozen operand: at most one operand can diverge in a subtrace
      const xa = pick([...frozen]);
      const ya = pickDefined();
      const args: [string, string] = rnd() < 0.5 ? [xa, ya] : [ya, xa];
      const vx = current.get(args[0])!;
      const vy = current.get(args[1])!;
      if (fn === "mul" && (vx === 0 || vy === 0)) continue; // 0 absorbs the other operand
      if (fn === "sub" && args[0] === args[1]) continue; // always 0, ignores its operand
      const result = fn === "add" ? vx + vy : fn === "sub" ? vx - vy : vx * vy;
      if (!valueUsed(out, result)) {
        trace.push({ op: "compute", out, fn, args });
        recordWrite(out, result);
        if (depth === 0) defined.add(out);
        return true;
      }
    }
    return false;
  };

  const tryFlag = (): boolean => {
    const fresh = FLAG_VARS.find((f) => !usedValues.has(f) && !availableFlags.includes(f));
    if (fresh === undefined || remaining() < 1) return false;
    const value = Math.floor(rnd() * 2);
    trace.push({ op: "const", out: fresh, value });
    recordWrite(fresh, value);
    availableFlags.push(fresh);
    return true;
  };

  const emitStatement = (depth: number): void => {
    if (remaining() < 1) return;
    if (depth === 0 && availableFlags.length < 3 && rnd() < 0.3 && tryFlag()) return;
    if (!(rnd() < 0.35 ? tryConst(depth) : tryCompute(depth))) {
      if (!tryConst(depth)) tryCompute(depth);
    }
  };

  // `reserve` events must be left over for the enclosing structure (end
  // markers), so the trace never exceeds maxEvents.
  const emitBody = (depth: number, count: number, reserve: number): void => {
    for (let n = 0; n < count; n++) {
      if (remaining() < reserve + 1) return;
      if (depth < 2 && availableFlags.length > 0 && rnd() < 0.35 && remaining() >= reserve + 4) {
        emitIf(depth, reserve);
      } else {
        emitStatement(depth);
      }
    }
  };

  const emitIf = (depth: number, reserve: number): void => {
    if (remaining() < reserve + 3) return;
    const flag = availableFlags.pop()!;
    const condValue = current.get(flag)!;
    trace.push({ op: "if", cond: flag });
    const snapshot = new Map(current);
    emitBody(depth + 1, 1 + Math.floor(rnd() * 2), reserve + 1);
    const thenState = new Map(current);
    const withElse = rnd() < 0.5 && remaining() >= reserve + 3;
    if (withElse) {
      current.clear();
      for (const [k, v] of snapshot) current.set(k, v);
      trace.push({ op: "else" });
      emitBody(depth + 1, 1 + Math.floor(rnd() * 2), reserve + 1);
    }
    trace.push({ op: "end" });
    // keep the state of the branch the full replay will actually take
    const taken = condValue !== 0 ? thenState : withElse ? new Map(current) : snapshot;
    current.clear();
    for (const [k, v] of taken) current.set(k, v);
  };

  // Seed at least two data variables, then fill the budget.
  while (defined.size < 2) {
    const v = DATA_VARS[defined.size];
    const value = Math.floor(rnd() * 10);
    trace.push({ op: "const", out: v, value });
    recordWrite(v, value);
    defined.add(v);
    frozen.add(v);
  }
  while (remaining() >= 1) {
    const before = trace.length;
    if (availableFlags.length > 0 && rnd() < 0.4 && remaining() >= 3) {
      emitIf(0, 0);
    } else {
      emitStatement(0);
    }
    if (trace.length === before) break; // no progress possible
  }
  const target = trace.length;
  // Target the most-written variable to maximize the dependence chain.
  let hot = pickDefined();
  for (const v of defined) {
    if ((writeCounts.get(v) ?? 0) > (writeCounts.get(hot) ?? 0)) hot = v;
  }
  trace.push({ op: "output", arg: hot });
  return { trace, target };
}
