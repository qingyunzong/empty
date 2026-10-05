/**
 * Differential test: random stratified programs over a finite constant
 * domain, random insert/retract sequences; after every single operation the
 * incrementally maintained state (model + full provenance) must equal a
 * from-scratch recomputation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, Snapshot } from "../src/engine.js";

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

interface PredSpec {
  readonly name: string;
  readonly arity: number;
  readonly stratum: number; // 0 = EDB
  readonly rules: string[];
}

interface RandomProgram {
  readonly preds: PredSpec[];
  readonly edbPreds: PredSpec[];
  readonly facts: Array<[string, string[]]>;
  readonly ruleText: string;
}

const DOMAIN = ["a", "b", "c", "d"];
const VARS = ["X", "Y", "Z"];

function generateProgram(rand: () => number): RandomProgram {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const int = (n: number) => Math.floor(rand() * n);

  const edbCount = 2 + int(2);
  const idbCount = 3 + int(3);
  const preds: PredSpec[] = [];
  for (let i = 0; i < edbCount; i++) {
    preds.push({ name: `e${i}`, arity: 1 + int(2), stratum: 0, rules: [] });
  }
  for (let i = 0; i < idbCount; i++) {
    preds.push({ name: `p${i}`, arity: 1 + int(2), stratum: 1 + int(3), rules: [] });
  }
  const edbPreds = preds.filter((p) => p.stratum === 0);
  const idbPreds = preds.filter((p) => p.stratum > 0);

  const term = (bound: string[]): string =>
    bound.length > 0 && rand() < 0.7 ? pick(bound) : JSON.stringify(pick(DOMAIN));

  const mutable = preds.map((p) => ({ ...p, rules: [...p.rules] }));
  const byName = new Map(mutable.map((p) => [p.name, p]));

  for (const head of mutable.filter((p) => p.stratum > 0)) {
    const ruleCount = 1 + int(2);
    for (let r = 0; r < ruleCount; r++) {
      const posCount = 1 + int(2);
      const posLits: string[] = [];
      const bound: string[] = [];
      for (let k = 0; k < posCount; k++) {
        const candidates = mutable.filter(
          (p) => p.stratum === 0 || p.stratum <= head.stratum,
        );
        const lp = pick(candidates);
        const args: string[] = [];
        for (let a = 0; a < lp.arity; a++) {
          if (rand() < 0.6) {
            const v = VARS[int(VARS.length)]!;
            args.push(v);
            if (!bound.includes(v)) bound.push(v);
          } else {
            args.push(JSON.stringify(pick(DOMAIN)));
          }
        }
        posLits.push(`${lp.name}(${args.join(", ")})`);
      }
      const negLits: string[] = [];
      const negCount = int(3); // 0..2
      for (let k = 0; k < negCount; k++) {
        const candidates = mutable.filter(
          (p) => p.stratum === 0 || p.stratum < head.stratum,
        );
        const lp = pick(candidates);
        const args = Array.from({ length: lp.arity }, () => term(bound));
        negLits.push(`not ${lp.name}(${args.join(", ")})`);
      }
      const headArgs = Array.from({ length: head.arity }, () => term(bound));
      head.rules.push(
        `${head.name}(${headArgs.join(", ")}) :- ${[...posLits, ...negLits].join(", ")}.`,
      );
    }
  }

  const facts: Array<[string, string[]]> = [];
  for (const p of edbPreds) {
    const tuples =
      p.arity === 1
        ? DOMAIN.map((a) => [a])
        : DOMAIN.flatMap((a) => DOMAIN.map((b) => [a, b]));
    for (const t of tuples) {
      if (rand() < 0.25) facts.push([p.name, t]);
    }
  }

  return {
    preds: mutable,
    edbPreds: mutable.filter((p) => p.stratum === 0),
    facts,
    ruleText: mutable.flatMap((p) => p.rules).join("\n"),
  };
}

test("incremental maintenance equals full recompute on random programs", () => {
  const PROGRAMS = Number(process.env.DIFF_PROGRAMS ?? 40);
  const OPS = Number(process.env.DIFF_OPS ?? 25);
  for (let seed = 1; seed <= PROGRAMS; seed++) {
    const rand = mulberry32(seed * 2654435761);
    const program = generateProgram(rand);
    const engine = new Engine();
    if (program.ruleText.trim().length > 0) engine.addRules(program.ruleText);
    for (const [pred, args] of program.facts) engine.addFact(pred, ...args);

    const check = (ctx: string) => {
      const incremental: Snapshot = engine.snapshot();
      engine.recompute();
      assert.deepEqual(
        engine.snapshot(),
        incremental,
        `seed=${seed} ${ctx}\nrules:\n${program.ruleText}`,
      );
    };
    check("initial load");

    for (let op = 0; op < OPS; op++) {
      const pred = program.edbPreds[Math.floor(rand() * program.edbPreds.length)]!;
      const tuple = Array.from(
        { length: pred.arity },
        () => DOMAIN[Math.floor(rand() * DOMAIN.length)]!,
      );
      if (rand() < 0.5) {
        engine.addFact(pred.name, ...tuple);
        check(`op#${op} addFact ${pred.name}(${tuple})`);
      } else {
        engine.retractFact(pred.name, ...tuple);
        check(`op#${op} retractFact ${pred.name}(${tuple})`);
      }
    }
  }
});

test("recompute is idempotent", () => {
  const rand = mulberry32(12345);
  const program = generateProgram(rand);
  const engine = new Engine();
  engine.addRules(program.ruleText);
  for (const [pred, args] of program.facts) engine.addFact(pred, ...args);
  const first = engine.snapshot();
  engine.recompute();
  engine.recompute();
  assert.deepEqual(engine.snapshot(), first);
});
