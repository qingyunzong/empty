'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { settle, parseEvent } = require('../lib');
const { main } = require('../cli');

function run(events) {
  return settle(events.map((e) => parseEvent(JSON.stringify(e), 0)));
}

function runCli(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
  const input = path.join(dir, 'events.jsonl');
  const output = path.join(dir, 'settle.json');
  fs.writeFileSync(input, lines.join('\n') + '\n');
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let status;
  try {
    status = main(['node', 'cli.js', input, output]);
  } finally {
    console.error = origError;
  }
  const out = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : undefined;
  return { status, stderr: errors.join('\n'), output: out };
}

test('tier boundary 999 vs 1000', () => {
  const rule = {
    type: 'rule',
    ruleId: 'r1',
    scope: 'product',
    productId: 'p1',
    tiers: [
      { min: 0, bps: 100 },
      { min: 1000, bps: 200 },
    ],
  };
  const below = run([rule, { type: 'charge', id: 'c1', merchantId: 'm1', productId: 'p1', period: '2026-01', amount: 999 }]);
  assert.equal(below.periods[0].volume, 999);
  assert.equal(below.periods[0].tier.min, 0);
  assert.equal(below.periods[0].rebate, 9);

  const at = run([rule, { type: 'charge', id: 'c1', merchantId: 'm1', productId: 'p1', period: '2026-01', amount: 1000 }]);
  assert.equal(at.periods[0].volume, 1000);
  assert.equal(at.periods[0].tier.min, 1000);
  assert.equal(at.periods[0].rebate, 20);
});

test('post-snapshot correction only enters supplement, snapshot hash unchanged', () => {
  const base = [
    { type: 'rule', ruleId: 'r1', scope: 'product', productId: 'p1', tiers: [{ min: 0, bps: 200 }] },
    { type: 'charge', id: 'c1', merchantId: 'm1', productId: 'p1', period: '2026-01', amount: 600 },
    { type: 'charge', id: 'c2', merchantId: 'm1', productId: 'p1', period: '2026-01', amount: 500 },
    { type: 'snapshot', id: 's1', merchantId: 'm1', period: '2026-01' },
  ];
  const clean = run(base);
  const withCorrection = run([...base, { type: 'correct', id: 'x1', linksTo: 'c1' }]);

  const p = withCorrection.periods[0];
  assert.equal(p.snapshot.volume, 1100);
  assert.equal(p.snapshot.rebate, 22);
  assert.equal(p.snapshot.hash, clean.periods[0].snapshot.hash);
  assert.equal(p.volume, 1100);
  assert.equal(p.rebate, 22);

  assert.equal(p.supplements.length, 1);
  const sup = p.supplements[0];
  assert.deepEqual(sup.corrections, ['x1']);
  assert.equal(sup.volume, 500);
  assert.equal(sup.rebate, 10);
  assert.equal(sup.deltaVolume, -600);
  assert.equal(sup.deltaRebate, -12);

  assert.deepEqual(p.adjustments, [{ chargeId: 'c1', corrections: ['x1'] }]);

  const again = run([...base, { type: 'correct', id: 'x1', linksTo: 'c1' }]);
  assert.equal(again.periods[0].snapshot.hash, p.snapshot.hash);
});

test('tied rules break by ascending rate then ruleId', () => {
  const charge = { type: 'charge', id: 'c1', merchantId: 'm1', productId: 'p1', period: '2026-01', amount: 1000 };
  const mk = (ruleId, bps, ts) => ({ type: 'rule', ruleId, scope: 'merchant', merchantId: 'm1', ts, tiers: [{ min: 0, bps }] });

  const byRate = run([mk('rA', 150, 1), mk('rB', 100, 1), charge]);
  assert.equal(byRate.periods[0].ruleId, 'rB');
  assert.equal(byRate.periods[0].rebate, 10);

  const byId = run([mk('rB', 100, 1), mk('rA', 100, 1), charge]);
  assert.equal(byId.periods[0].ruleId, 'rA');

  const recent = run([mk('rOld', 100, 1), mk('rNew', 300, 2), charge]);
  assert.equal(recent.periods[0].ruleId, 'rNew');

  const inherited = run([
    { type: 'rule', ruleId: 'rP', scope: 'product', productId: 'p1', ts: 9, tiers: [{ min: 0, bps: 50 }] },
    mk('rM', 400, 1),
    charge,
  ]);
  assert.equal(inherited.periods[0].ruleId, 'rM');

  const fallback = run([
    { type: 'rule', ruleId: 'rP', scope: 'product', productId: 'p1', tiers: [{ min: 0, bps: 50 }] },
    charge,
  ]);
  assert.equal(fallback.periods[0].ruleId, 'rP');
  assert.equal(fallback.periods[0].rebate, 5);
});

test('E_LINK on dangling or repeated correction links', () => {
  assert.throws(
    () => run([{ type: 'correct', id: 'x1', linksTo: 'nope' }]),
    (err) => err.code === 'E_LINK',
  );
  const events = [
    { type: 'charge', id: 'c1', merchantId: 'm1', productId: 'p1', period: '2026-01', amount: 10 },
    { type: 'correct', id: 'x1', linksTo: 'c1' },
    { type: 'correct', id: 'x2', linksTo: 'c1' },
  ];
  assert.throws(() => run(events), (err) => err.code === 'E_LINK');
});

test('E_SNAPSHOT on duplicate snapshot and hash mismatch', () => {
  const dup = [
    { type: 'charge', id: 'c1', merchantId: 'm1', productId: 'p1', period: '2026-01', amount: 10 },
    { type: 'snapshot', id: 's1', merchantId: 'm1', period: '2026-01' },
    { type: 'snapshot', id: 's2', merchantId: 'm1', period: '2026-01' },
  ];
  assert.throws(() => run(dup), (err) => err.code === 'E_SNAPSHOT');

  const badHash = [
    { type: 'charge', id: 'c1', merchantId: 'm1', productId: 'p1', period: '2026-01', amount: 10 },
    { type: 'snapshot', id: 's1', merchantId: 'm1', period: '2026-01', hash: 'deadbeef' },
  ];
  assert.throws(() => run(badHash), (err) => err.code === 'E_SNAPSHOT');
});

test('cli writes settle.json and exits 0', () => {
  const res = runCli([
    JSON.stringify({ type: 'rule', ruleId: 'r1', scope: 'product', productId: 'p1', tiers: [{ min: 0, bps: 100 }] }),
    JSON.stringify({ type: 'charge', id: 'c1', merchantId: 'm1', productId: 'p1', period: '2026-01', amount: 1000 }),
  ]);
  assert.equal(res.status, 0);
  assert.equal(res.output.periods[0].rebate, 10);
});

test('cli exits 1 with E_LINK and E_SNAPSHOT', () => {
  const link = runCli([JSON.stringify({ type: 'correct', id: 'x1', linksTo: 'ghost' })]);
  assert.equal(link.status, 1);
  assert.match(link.stderr, /E_LINK/);

  const snap = runCli([
    JSON.stringify({ type: 'snapshot', id: 's1', merchantId: 'm1', period: '2026-01' }),
    JSON.stringify({ type: 'snapshot', id: 's2', merchantId: 'm1', period: '2026-01' }),
  ]);
  assert.equal(snap.status, 1);
  assert.match(snap.stderr, /E_SNAPSHOT/);
});
