import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/index.js';
import { main } from '../src/cli.js';

function capture(argv) {
  const io = { out: [], err: [] };
  const code = main(argv, { out: (s) => io.out.push(s), err: (s) => io.err.push(s) });
  return { code, stdout: io.out.join('\n'), stderr: io.err.join('\n') };
}

function total(state, sec) {
  return state.positions[sec]?.total ?? 0;
}

// Acceptance 1: split -> reverse -> restated
test('split, withdrawal, then restatement (RESTATED only affects post-ex lots)', () => {
  const src = `
action a1: ACME split 1/2 ex 2024-03-01 v1
reverse a1 ex 2024-03-05 v2
restated a1: ACME split 1/4 ex 2024-03-10 v3`;
  const lots = { cash: 0, lots: [
    { id: 'L1', security: 'ACME', quantity: 100, acquired: '2024-01-01' }, // pre-ex
    { id: 'L2', security: 'ACME', quantity: 50, acquired: '2024-03-03' },  // post-ex
  ] };
  const st = run(src, lots);
  // L1: split to 200, reversed back to 100, restatement must NOT touch it.
  // L2: untouched by the original (acquired after ex), restatement 1/4 -> 200.
  assert.equal(total(st, 'ACME'), 300);
  const [l1, l2] = st.positions.ACME.lots;
  assert.equal(l1.quantity, 100);
  assert.equal(l2.quantity, 200);
  // Reversal is a new corporate action in the ledger; history is preserved.
  const types = st.ledger.map((e) => e.type);
  assert.deepEqual(types, ['APPLY', 'REVERSE', 'RESTATED']);
  assert.equal(st.ledger[1].effect.reverses, 'a1');
  assert.equal(st.ledger[2].effect.restates, 'a1');
  assert.equal(st.ledger[2].effect.mode, 'post');
  assert.equal(st.adjustments.length, 0);
});

// Acceptance 2: sell part of the lots, then reverse at the boundary
test('reversal after partial sell: shortfall becomes payable, never negative', () => {
  const src = `
action a1: ACME split 1/2 ex 2024-03-01 v1
sell ACME 150 on 2024-03-02
reverse a1 ex 2024-03-05 v2`;
  const lots = { cash: 0, lots: [
    { id: 'L1', security: 'ACME', quantity: 100, acquired: '2024-01-01' },
    { id: 'L2', security: 'ACME', quantity: 100, acquired: '2024-02-01' },
  ] };
  const st = run(src, lots);
  // After split: L1=200, L2=200. Sell 150 FIFO -> L1=50, L2=200.
  // Reversal must remove 100 per lot: L1 50->0 with 50 payable, L2 200->100.
  assert.equal(total(st, 'ACME'), 100);
  assert.equal(st.positions.ACME.lots.length, 1);
  assert.equal(st.positions.ACME.lots[0].id, 'L2');
  assert.deepEqual(st.adjustments, [
    { type: 'payable', sec: 'ACME', shares: 50, reason: 'reversal of a1: lot L1 partially sold' },
  ]);
  for (const l of st.positions.ACME.lots) assert.ok(l.quantity >= 0);
});

test('reversal after selling an entire lot: full shortfall is payable', () => {
  const src = `
action a1: ACME split 1/2 ex 2024-03-01 v1
sell ACME 200 on 2024-03-02
reverse a1 ex 2024-03-05 v2`;
  const lots = { cash: 0, lots: [
    { id: 'L1', security: 'ACME', quantity: 100, acquired: '2024-01-01' },
    { id: 'L2', security: 'ACME', quantity: 100, acquired: '2024-02-01' },
  ] };
  const st = run(src, lots);
  // Sell 200 FIFO consumes L1 entirely (L1 was 200 post-split).
  assert.equal(total(st, 'ACME'), 100); // L2: 200 -> 100 after reversal
  assert.equal(st.adjustments.length, 1);
  assert.equal(st.adjustments[0].type, 'payable');
  assert.equal(st.adjustments[0].shares, 100);
  assert.match(st.adjustments[0].reason, /fully sold/);
});

test('dividend reversal claws back cash; shortfall becomes cash payable', () => {
  const src = `
action d1: ACME dividend $2 ex 2024-03-01 v1
reverse d1 ex 2024-03-05 v2`;
  const st = run(src, { cash: 50, lots: [{ id: 'L1', security: 'ACME', quantity: 100, acquired: '2024-01-01' }] });
  // Dividend: +200 (cash 250). Reversal: deduct 200 -> cash 50. No payable.
  assert.equal(st.cash, 50);
  assert.equal(st.adjustments.length, 0);

  const st2 = run(src, { cash: 0, lots: [{ id: 'L1', security: 'ACME', quantity: 100, acquired: '2024-01-01' }] });
  // Dividend +200 then clawback of 200 -> cash 0, nothing owed.
  assert.equal(st2.cash, 0);
  assert.equal(st2.adjustments.length, 0);

  const srcSpend = `
action d1: ACME dividend $2 ex 2024-03-01 v1
action d2: ACME dividend $1.5 ex 2024-03-03 v1
reverse d1 ex 2024-03-05 v2
reverse d2 ex 2024-03-06 v3`;
  const st3 = run(srcSpend, { cash: 0, lots: [{ id: 'L1', security: 'ACME', quantity: 100, acquired: '2024-01-01' }] });
  // +200, +150 (cash 350); reverse d1 -200 (150); reverse d2 needs 150 -> cash 0.
  assert.equal(st3.cash, 0);
  assert.equal(st3.adjustments.length, 0);

  const srcShort = `
action d1: ACME dividend $2 ex 2024-03-01 v1
action t1: ACME tender $0.1 for 1 ex 2024-03-02 v1
reverse d1 ex 2024-03-05 v2`;
  const st4 = run(srcShort, { cash: 0, lots: [{ id: 'L1', security: 'ACME', quantity: 100, acquired: '2024-01-01' }] });
  // +200 dividend, tender all 100 sh at $0.1 -> +10 (cash 210).
  // Reverse d1: -200 -> cash 10. Reverse t1 would need 10 -> covered.
  assert.equal(st4.cash, 10);
  assert.equal(st4.adjustments.length, 0);
});

test('tender reversal restores lots or books a receivable', () => {
  const src = `
action t1: ACME tender $10 for 1/2 ex 2024-03-01 v1
reverse t1 ex 2024-03-05 v2`;
  const st = run(src, { cash: 0, lots: [{ id: 'L1', security: 'ACME', quantity: 100, acquired: '2024-01-01' }] });
  // Tender: sell 50 @10 -> cash 500, L1=50. Reversal: restore 50, cash -500.
  assert.equal(total(st, 'ACME'), 100);
  assert.equal(st.cash, 0);
  assert.equal(st.adjustments.length, 0);

  const srcSold = `
action t1: ACME tender $10 for 1/2 ex 2024-03-01 v1
sell ACME 50 on 2024-03-02
reverse t1 ex 2024-03-05 v2`;
  const st2 = run(srcSold, { cash: 0, lots: [{ id: 'L1', security: 'ACME', quantity: 100, acquired: '2024-01-01' }] });
  // L1 fully sold after tender; buyback shares arrive as a receivable.
  assert.equal(total(st2, 'ACME'), 0);
  assert.equal(st2.adjustments.length, 1);
  assert.equal(st2.adjustments[0].type, 'receivable');
  assert.equal(st2.adjustments[0].shares, 50);
  assert.equal(st2.cash, 0);
});

test('same ex-date same security: order by version, then hash tie-break', () => {
  // v2 dividend is announced before v1 split in the source, but the
  // lower announcement version must be applied first.
  const src = `
action d1: ACME dividend $1 ex 2024-03-01 v2
action a1: ACME split 1/2 ex 2024-03-01 v1`;
  const st = run(src, { cash: 0, lots: [{ id: 'L1', security: 'ACME', quantity: 100, acquired: '2024-01-01' }] });
  // v1 split first (100 -> 200), then v2 dividend on 200 shares.
  assert.equal(st.cash, 200);
  assert.deepEqual(st.ledger.map((e) => e.id), ['a1', 'd1']);

  // Same version: deterministic hash tie-break, independent of source order.
  const mk = (order) => order.join('\n');
  const x = 'action x1: ACME dividend $1 ex 2024-03-01 v1';
  const y = 'action y1: ACME dividend $2 ex 2024-03-01 v1';
  const s1 = run(mk([x, y]), { cash: 0, lots: [{ id: 'L1', security: 'ACME', quantity: 10, acquired: '2024-01-01' }] });
  const s2 = run(mk([y, x]), { cash: 0, lots: [{ id: 'L1', security: 'ACME', quantity: 10, acquired: '2024-01-01' }] });
  assert.deepEqual(s1.ledger.map((e) => e.id), s2.ledger.map((e) => e.id));
  assert.equal(s1.cash, 30);
});

test('security scopes are isolated; actions on one security compose in order', () => {
  const src = `
action a1: ACME split 1/2 ex 2024-03-01 v1
action b1: BETA split 1/4 ex 2024-03-01 v1
action d1: ACME dividend $1 ex 2024-03-02 v1`;
  const st = run(src, { cash: 0, lots: [
    { id: 'L1', security: 'ACME', quantity: 100, acquired: '2024-01-01' },
    { id: 'L2', security: 'BETA', quantity: 40, acquired: '2024-01-01' },
  ] });
  assert.equal(total(st, 'ACME'), 200);
  assert.equal(total(st, 'BETA'), 160);
  assert.equal(st.cash, 200); // dividend only on ACME shares
});

test('CLI: corp apply actions.ca lots.json --ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corp-'));
  const ca = join(dir, 'actions.ca');
  const lj = join(dir, 'lots.json');
  writeFileSync(ca, 'action a1: ACME split 1/2 ex 2024-03-01 v1\nreverse a1 ex 2024-03-05 v2\n');
  writeFileSync(lj, JSON.stringify({ cash: 5, lots: [{ id: 'L1', security: 'ACME', quantity: 100, acquired: '2024-01-01' }] }));
  const r1 = capture(['apply', ca, lj, '--ledger']);
  assert.equal(r1.code, 0);
  const out = JSON.parse(r1.stdout);
  assert.equal(out.positions.ACME.total, 100);
  assert.equal(out.cash, 5);
  assert.deepEqual(out.ledger.map((e) => e.type), ['APPLY', 'REVERSE']);

  const r2 = capture(['apply', ca, lj]);
  assert.equal(r2.code, 0);
  const out2 = JSON.parse(r2.stdout);
  assert.equal(out2.ledger, undefined);
});

test('CLI: static errors are reported with their code and exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corp-'));
  const ca = join(dir, 'bad.ca');
  const lj = join(dir, 'lots.json');
  writeFileSync(ca, 'action a1: ACME split 2 ex 2024-03-01 v1\n');
  writeFileSync(lj, '{}');
  const r = capture(['apply', ca, lj]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^E_RATIO: /);
});
