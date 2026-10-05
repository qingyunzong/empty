import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { Command, Op, historyOf, integer } from "../src/arbitrary";
import { check } from "../src/check";
import { Rng, seedFromString } from "../src/rng";
import { assertSingleStepIrreducible } from "./helpers";

interface Model {
  balance: number;
}

const deposit: Command<Model, number> = {
  name: "deposit",
  args: integer(1, 50),
  precondition: () => true,
  next: (m, a) => ({ balance: m.balance + a }),
};

const withdraw: Command<Model, number> = {
  name: "withdraw",
  args: integer(1, 50),
  precondition: (m, a) => m.balance >= a,
  next: (m, a) => ({ balance: m.balance - a }),
};

const makeArb = () =>
  historyOf<Model>([deposit, withdraw], () => ({ balance: 0 }), {
    maxLength: 12,
  });

const replay = (ops: Op[]): Model => {
  let m: Model = { balance: 0 };
  for (const op of ops) {
    const cmd = op.name === "deposit" ? deposit : withdraw;
    ok(
      cmd.precondition(m, op.args as number),
      `precondition violated for ${op.name}(${op.args}) at balance ${m.balance}`,
    );
    m = cmd.next(m, op.args as number);
  }
  return m;
};

test("generated histories are valid by construction", () => {
  const arb = makeArb();
  const rng = new Rng(seedFromString("history-gen"));
  for (let i = 0; i < 100; i++) {
    const ops = arb.generate(rng, 8);
    ok(ops.length >= 1 && ops.length <= 12);
    replay(ops); // throws if any precondition is violated
    ok(arb.contract(ops));
  }
});

test("shrinking a history only emits replayable histories", () => {
  const arb = makeArb();
  const rng = new Rng(seedFromString("history-shrink"));
  for (let i = 0; i < 50; i++) {
    const ops = arb.generate(rng, 8);
    for (const s of arb.shrink(ops)) replay(s);
  }
});

test("check on histories: falsified, contract preserved, irreducible", () => {
  const arb = makeArb();
  const property = (ops: Op[]) => replay(ops).balance <= 60;
  const report = check(arb, property, { seed: "history-check", numRuns: 200 });
  equal(report.status, "falsified");
  const shrinkEntries = report.trace.filter((e) => e.phase === "shrink");
  ok(shrinkEntries.length > 0);
  for (const e of shrinkEntries) replay(e.value as Op[]);
  replay(report.minimal!);
  assertSingleStepIrreducible(arb, report.minimal!, (ops) => property(ops) === false);
});

test("exceptions inside history properties are errors, not falsifications", () => {
  const arb = makeArb();
  const property = (ops: Op[]) => {
    const m = replay(ops);
    if (m.balance > 60) throw new Error("balance invariant exploded");
    return true;
  };
  const report = check(arb, property, { seed: "history-error", numRuns: 200 });
  equal(report.status, "error");
  equal(report.error?.message, "balance invariant exploded");
  ok(report.minimal !== undefined);
});
