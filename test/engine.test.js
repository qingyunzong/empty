import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, EngineError } from '../src/engine.js';
import { RULE_VERSIONS, computeFee } from '../src/rules.js';

const DAY = '2026-10-03';

function feeOf(engine, account) {
  return engine.accounts.get(account).breakdown.net;
}

test('amend equals cancel plus add, never double counts', () => {
  const e = new Engine({ day: DAY });
  e.apply({ type: 'account', account: 'A', packages: ['P-STD'] });
  e.apply({ type: 'trade', id: 't1', account: 'A', amount: 1_000_000 });
  assert.equal(e.accounts.get('A').turnover, 1_000_000);
  assert.equal(feeOf(e, 'A'), 500);
  const diff = e.apply({ type: 'amend', id: 't1', newId: 't2', amount: 700_000 });
  assert.equal(e.accounts.get('A').turnover, 700_000);
  assert.equal(feeOf(e, 'A'), 350);
  assert.equal(diff.delta, -150);
  assert.ok(diff.invalidated.includes('trade:t1'));
  assert.ok(diff.invalidated.includes('trade:t2'));
  assert.throws(() => e.apply({ type: 'amend', id: 't1', newId: 't3', amount: 1 }), EngineError);
  assert.throws(() => e.apply({ type: 'amend', id: 't2', newId: 't2', amount: 1 }), EngineError);
});

test('invalidation propagates only for cross-tier accounts', () => {
  const e = new Engine({ day: DAY });
  e.apply({ type: 'account', account: 'A', packages: ['P-STD'] });
  e.apply({ type: 'account', account: 'B', packages: ['P-STD'] });
  e.apply({ type: 'trade', id: 'a1', account: 'A', amount: 900_000 });
  e.apply({ type: 'trade', id: 'b1', account: 'B', amount: 100_000 });
  const a = e.accounts.get('A');
  const b = e.accounts.get('B');
  const aV = a.feeVersion;
  const bV = b.feeVersion;

  const same = e.apply({ type: 'trade', id: 'a2', account: 'A', amount: 50_000 });
  assert.equal(same.crossed, false);
  assert.ok(!same.invalidated.includes('fee:A'));
  assert.ok(!same.invalidated.includes('invoice:A'));
  assert.equal(a.feeVersion, aV);
  assert.equal(feeOf(e, 'A'), computeFee(RULE_VERSIONS.v1.packages[0], 950_000).net);

  const cross = e.apply({ type: 'trade', id: 'a3', account: 'A', amount: 100_000 });
  assert.equal(cross.crossed, true);
  assert.ok(cross.invalidated.includes('fee:A'));
  assert.ok(cross.invalidated.includes('invoice:A'));
  assert.ok(!cross.invalidated.some((n) => n.endsWith(':B')));
  assert.equal(a.feeVersion, aV + 1);
  assert.equal(b.feeVersion, bV);
  assert.equal(feeOf(e, 'A'), 500 + 50_000 * 0.0004);
});

test('tied best packages are all listed, rule id breaks the tie', () => {
  const e = new Engine({ day: DAY });
  e.apply({ type: 'rules', version: 'v2' });
  e.apply({ type: 'trade', id: 't1', account: 'C', amount: 100_000 });
  const c = e.accounts.get('C');
  assert.deepEqual(c.tied, ['P-FLAT-A', 'P-FLAT-B']);
  assert.equal(c.selected, 'P-FLAT-A');
  assert.equal(c.breakdown.net, 40);
  const [line] = e.eod();
  assert.deepEqual(line.tied, ['P-FLAT-A', 'P-FLAT-B']);
  assert.equal(line.package, 'P-FLAT-A');
});

test('cancel drops account below minimum fee with explanation', () => {
  const e = new Engine({ day: DAY });
  e.apply({ type: 'account', account: 'A', packages: ['P-STD'] });
  e.apply({ type: 'trade', id: 't1', account: 'A', amount: 100_000 });
  assert.equal(feeOf(e, 'A'), 100);
  e.apply({ type: 'trade', id: 't2', account: 'A', amount: 150_000 });
  assert.equal(feeOf(e, 'A'), 125);
  const diff = e.apply({ type: 'cancel', id: 't2' });
  assert.equal(feeOf(e, 'A'), 100);
  assert.equal(diff.delta, -25);
  assert.ok(diff.reasons.some((r) => r.includes('minimum fee 100 applied')));
  const diff2 = e.apply({ type: 'cancel', id: 't1' });
  assert.equal(feeOf(e, 'A'), 0);
  assert.equal(diff2.delta, -100);
});

test('negative trades only as reversal referencing the original', () => {
  const e = new Engine({ day: DAY });
  e.apply({ type: 'account', account: 'A', packages: ['P-STD'] });
  e.apply({ type: 'trade', id: 't1', account: 'A', amount: 500_000 });
  assert.throws(
    () => e.apply({ type: 'trade', id: 'r0', account: 'A', amount: -100_000 }),
    /must reference original/,
  );
  assert.throws(
    () => e.apply({ type: 'trade', id: 'r1', account: 'A', amount: -100_000, of: 'nope' }),
    /unknown original/,
  );
  assert.throws(
    () => e.apply({ type: 'trade', id: 'r2', account: 'A', amount: -600_000, of: 't1' }),
    /exceeds remaining/,
  );
  const diff = e.apply({ type: 'trade', id: 'r3', account: 'A', amount: -200_000, of: 't1' });
  assert.equal(e.accounts.get('A').turnover, 300_000);
  assert.equal(diff.delta, -100);
  assert.throws(() => e.apply({ type: 'cancel', id: 'r3' }), /cannot cancel reversal/);
  assert.throws(
    () => e.apply({ type: 'trade', id: 'r4', account: 'A', amount: -100_000, of: 'r3' }),
    /cannot reverse a reversal/,
  );
});

test('certificates are deterministic across replays', () => {
  const events = [
    { type: 'account', account: 'A', packages: ['P-STD', 'P-PRO'] },
    { type: 'trade', id: 't1', account: 'A', amount: 2_500_000 },
    { type: 'trade', id: 't2', account: 'B', amount: 100_000 },
    { type: 'amend', id: 't2', newId: 't2b', amount: 900_000 },
    { type: 'trade', id: 'r1', account: 'A', amount: -500_000, of: 't1' },
    { type: 'rules', version: 'v2' },
    { type: 'cancel', id: 't2b' },
  ];
  const run = () => {
    const e = new Engine({ day: DAY });
    for (const ev of events) e.apply(ev);
    return e.eod().map((l) => l.certificate);
  };
  assert.deepEqual(run(), run());
});

test('rule version switch re-links fee nodes and reprices all accounts', () => {
  const e = new Engine({ day: DAY });
  e.apply({ type: 'account', account: 'A', packages: ['P-STD'] });
  e.apply({ type: 'trade', id: 'a1', account: 'A', amount: 1_100_000 });
  e.apply({ type: 'trade', id: 'b1', account: 'B', amount: 100_000 });
  const a = e.accounts.get('A');
  const b = e.accounts.get('B');
  const aV = a.feeVersion;
  const bV = b.feeVersion;
  const res = e.apply({ type: 'rules', version: 'v2' });
  assert.equal(res.from, 'v1');
  assert.ok(res.invalidated.includes('rules:v2'));
  assert.ok(res.invalidated.includes('fee:A'));
  assert.ok(res.invalidated.includes('invoice:B'));
  assert.equal(a.feeVersion, aV + 1);
  assert.equal(b.feeVersion, bV + 1);
  assert.equal(a.selected, 'P-FLAT-A');
  assert.deepEqual(a.tied, ['P-FLAT-A', 'P-FLAT-B']);
  assert.equal(feeOf(e, 'A'), 440);
  assert.throws(() => e.apply({ type: 'rules', version: 'v9' }), /unknown rule version/);
});

test('rebate applies above turnover threshold', () => {
  const e = new Engine({ day: DAY });
  e.apply({ type: 'account', account: 'A', packages: ['P-STD'] });
  e.apply({ type: 'trade', id: 't1', account: 'A', amount: 2_000_000 });
  const b = e.accounts.get('A').breakdown;
  assert.equal(b.gross, 900);
  assert.equal(b.rebate, 90);
  assert.equal(b.rebateId, 'R-VOL');
  assert.equal(b.net, 810);
});
