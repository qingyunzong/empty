'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine } = require('../lib/engine');
const { Wal } = require('../lib/wal');
const { computeRemaining, buildDomains, enumerateMatchings } = require('../lib/solver');
const { main } = require('../lib/cli');

// index.js forwards argv to main() and exits with its return code, so the CLI
// is exercised in-process (the sandbox forbids nested process spawning).
function runCli(argv) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    return { code: main(argv), stderr: errors.join('\n') };
  } finally {
    console.error = original;
  }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
}

test('acceptance 1: two pairs settle normally', () => {
  const engine = new Engine(path.join(tmpdir(), 'wal.log'));
  const result = engine.deliver({
    accounts: [
      { id: 'CASH_A', cash: 100000 },
      { id: 'CASH_B', cash: 100000 },
      { id: 'SEC_A', positions: { AAA: 200 } },
      { id: 'SEC_B', positions: { BBB: 80 } },
    ],
    instructions: [
      { id: 'B1', side: 'buy', security: 'AAA', price: 10, quantity: 100, accounts: ['CASH_A'] },
      { id: 'B2', side: 'buy', security: 'BBB', price: 25, quantity: 80, accounts: ['CASH_B'] },
      { id: 'S1', side: 'sell', security: 'AAA', price: 10, quantity: 100, accounts: ['SEC_A'] },
      { id: 'S2', side: 'sell', security: 'BBB', price: 25, quantity: 80, accounts: ['SEC_B'] },
    ],
    permissions: [
      ['B1', 'S1'],
      ['B2', 'S2'],
    ],
  });
  assert.equal(result.status, 'SAT');
  assert.equal(result.pairs.length, 2);
  const first = result.pairs.find((p) => p.buy === 'B1');
  assert.equal(first.sell, 'S1');
  assert.equal(first.buyAccount, 'CASH_A');
  assert.equal(first.sellAccount, 'SEC_A');
  assert.equal(first.amount, 1000);
  const second = result.pairs.find((p) => p.buy === 'B2');
  assert.equal(second.sell, 'S2');
  assert.equal(second.amount, 2000);
  assert.equal(result.frozen.CASH_A.cash, 1000);
  assert.equal(result.frozen.CASH_B.cash, 2000);
  assert.equal(result.frozen.SEC_A.positions.AAA, 100);
  assert.equal(result.frozen.SEC_B.positions.BBB, 80);
  assert.equal(result.remaining.CASH_A.cash, 99000);
  assert.equal(result.remaining.SEC_A.positions.AAA, 100);
  assert.deepEqual(result.unmatched, []);
});

test('acceptance 2: cancellation unfreezes first, then incremental re-matching', () => {
  const dir = tmpdir();
  const walPath = path.join(dir, 'wal.log');
  const accounts = [
    { id: 'C1', cash: 1000 },
    { id: 'C2', cash: 1000 },
    { id: 'X1', positions: { AAA: 50 } },
    { id: 'X2', positions: { AAA: 50 } },
    { id: 'X3', positions: { AAA: 50 } },
  ];
  const instructions = [
    { id: 'B1', side: 'buy', security: 'AAA', price: 10, quantity: 50, accounts: ['C1'] },
    { id: 'B2', side: 'buy', security: 'AAA', price: 10, quantity: 50, accounts: ['C2'] },
    { id: 'S1', side: 'sell', security: 'AAA', price: 10, quantity: 50, accounts: ['X1'] },
    { id: 'S2', side: 'sell', security: 'AAA', price: 10, quantity: 50, accounts: ['X2'] },
  ];
  const permissions = [
    ['B1', 'S1'],
    ['B2', 'S2'],
    ['B1', 'S3'],
  ];

  const first = new Engine(walPath).deliver({ accounts, instructions, permissions });
  assert.equal(first.status, 'SAT');
  const b2Pair = first.pairs.find((p) => p.buy === 'B2');

  // Restart from the WAL, cancel S1, introduce S3: B1 must re-match incrementally.
  const engine = new Engine(walPath);
  engine.recover();
  const second = engine.deliver({
    accounts,
    instructions: [
      ...instructions,
      { id: 'S3', side: 'sell', security: 'AAA', price: 10, quantity: 50, accounts: ['X3'] },
    ],
    permissions,
    cancellations: ['S1'],
  });
  assert.equal(second.status, 'SAT');
  assert.equal(second.pairs.length, 2);
  assert.equal(second.pairs.find((p) => p.buy === 'B2').pairId, b2Pair.pairId); // untouched
  assert.equal(second.pairs.find((p) => p.buy === 'B1').sell, 'S3'); // re-matched
  assert.deepEqual(second.cancelled, ['S1']);

  // WAL order: unfreeze is logged before the pair is broken.
  const ops = engine.wal.records.map((r) => r.op);
  const unfreezeAt = ops.indexOf('unfreeze');
  const unpairAt = ops.indexOf('unpair');
  assert.ok(unfreezeAt !== -1 && unpairAt !== -1 && unfreezeAt < unpairAt);

  // S1's securities released; B1's cash frozen again exactly once for the new pair.
  assert.equal(second.frozen.X1, undefined);
  assert.equal(second.frozen.C1.cash, 500);
  assert.equal(second.frozen.X3.positions.AAA, 50);
  assert.equal(second.remaining.X1.positions.AAA, 50);
});

test('acceptance 3: WAL recovery completes unfreeze after crash, without double freezing', () => {
  const dir = tmpdir();
  const walPath = path.join(dir, 'wal.log');
  // Simulate the crash point: match logs written, cancel logged, unfreeze log NOT written.
  const wal = new Wal(walPath);
  wal.append({ op: 'match', pairId: 'P1', buy: 'B1', sell: 'S1', security: 'AAA', price: 10, quantity: 50, buyAccount: 'C1', sellAccount: 'X1', amount: 500 });
  wal.append({ op: 'match', pairId: 'P2', buy: 'B2', sell: 'S2', security: 'AAA', price: 10, quantity: 50, buyAccount: 'C2', sellAccount: 'X2', amount: 500 });
  wal.append({ op: 'cancel', instruction: 'S1' });
  // --- crash here ---

  const engine = new Engine(walPath);
  // Freeze reconstructed from the WAL exactly once, not re-executed.
  assert.equal(engine.frozen.C1.cash, 500);
  assert.equal(engine.frozen.C2.cash, 500);
  engine.recover();
  assert.deepEqual(
    engine.wal.records.slice(3).map((r) => r.op),
    ['unfreeze', 'unpair']
  );
  assert.equal(engine.frozen.C1, undefined);
  assert.equal(engine.frozen.X1, undefined);
  assert.equal(engine.frozen.C2.cash, 500); // P2 survives
  assert.ok(!engine.pairs.has('P1') && engine.pairs.has('P2'));

  // A second restart is idempotent: no duplicate unfreeze, no double freeze.
  const again = new Engine(walPath);
  again.recover();
  assert.equal(again.wal.records.filter((r) => r.op === 'unfreeze').length, 1);
  assert.equal(again.wal.records.filter((r) => r.op === 'match').length, 2);
  assert.equal(again.frozen.C2.cash, 500);
  assert.equal(again.frozen.C1, undefined);
});

test('acceptance 4: insufficient balance is UNSAT with the shortest instruction cycle', () => {
  const engine = new Engine(path.join(tmpdir(), 'wal.log'));
  const result = engine.deliver({
    accounts: [
      { id: 'C1', cash: 1500 },
      { id: 'X1', positions: { AAA: 200 } },
    ],
    instructions: [
      { id: 'B1', side: 'buy', security: 'AAA', price: 10, quantity: 100, accounts: ['C1'] },
      { id: 'B2', side: 'buy', security: 'AAA', price: 10, quantity: 100, accounts: ['C1'] },
      { id: 'S1', side: 'sell', security: 'AAA', price: 10, quantity: 100, accounts: ['X1'] },
      { id: 'S2', side: 'sell', security: 'AAA', price: 10, quantity: 100, accounts: ['X1'] },
    ],
    permissions: [
      ['B1', 'S1'],
      ['B1', 'S2'],
      ['B2', 'S1'],
      ['B2', 'S2'],
    ],
  });
  assert.equal(result.status, 'UNSAT');
  assert.deepEqual(result.conflict.cycle, ['B1', 'B2']);
  assert.equal(result.conflict.kind, 'cash');
  assert.equal(result.conflict.resource, 'C1');
  assert.equal(result.pairs.length, 0);
  assert.deepEqual(result.unmatched.sort(), ['B1', 'B2', 'S1', 'S2']);
});

test('propagation deletes impossible accounts from domains', () => {
  const accounts = [
    { id: 'POOR', cash: 100 },
    { id: 'RICH', cash: 1000 },
  ];
  const remaining = computeRemaining(accounts, { RICH: { cash: 600, positions: {} } });
  const domains = buildDomains(
    [{ id: 'B1', side: 'buy', security: 'AAA', price: 10, quantity: 50 }],
    accounts,
    remaining
  );
  // POOR lacks cash (100 < 500); RICH is left with 400 after freezing, also impossible.
  assert.deepEqual(domains.get('B1'), []);
});

test('enumerates all pairings for <=4 instructions', () => {
  const accounts = [{ id: 'C', cash: 100000 }, { id: 'X', positions: { AAA: 200 } }];
  const instructions = [
    { id: 'B1', side: 'buy', security: 'AAA', price: 10, quantity: 50 },
    { id: 'B2', side: 'buy', security: 'AAA', price: 10, quantity: 50 },
    { id: 'S1', side: 'sell', security: 'AAA', price: 10, quantity: 50 },
    { id: 'S2', side: 'sell', security: 'AAA', price: 10, quantity: 50 },
  ];
  const remaining = computeRemaining(accounts, {});
  const all = enumerateMatchings({
    instructions,
    remaining,
    permissions: null,
    mustMatch: new Set(instructions.map((i) => i.id)),
    domains: buildDomains(instructions, accounts, remaining),
  });
  assert.equal(all.length, 2); // B1-S1+B2-S2 and B1-S2+B2-S1
  for (const solution of all) {
    assert.equal(solution.length, 2);
    assert.equal(new Set(solution.flatMap((p) => [p.buy, p.sell])).size, 4);
  }
});

test('cli: bad JSON exits with code 1', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'in.json');
  fs.writeFileSync(input, '{not json');
  const run = runCli(['deliver', input, path.join(dir, 'out.json')]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /invalid JSON/);
});

test('cli: single-sided instructions exit with code 1', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'in.json');
  fs.writeFileSync(
    input,
    JSON.stringify({
      accounts: [{ id: 'C1', cash: 1000 }],
      instructions: [{ id: 'B1', side: 'buy', security: 'AAA', price: 10, quantity: 50 }],
    })
  );
  const run = runCli(['deliver', input, path.join(dir, 'out.json')]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /single-sided/);
});

test('cli: deliver writes output.json and exits 0', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'in.json');
  const output = path.join(dir, 'out.json');
  fs.writeFileSync(
    input,
    JSON.stringify({
      accounts: [{ id: 'C1', cash: 1000 }, { id: 'X1', positions: { AAA: 50 } }],
      instructions: [
        { id: 'B1', side: 'buy', security: 'AAA', price: 10, quantity: 50 },
        { id: 'S1', side: 'sell', security: 'AAA', price: 10, quantity: 50 },
      ],
    })
  );
  const run = runCli(['deliver', input, output]);
  assert.equal(run.code, 0);
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(result.status, 'SAT');
  assert.equal(result.pairs.length, 1);
  assert.equal(result.frozen.C1.cash, 500);
});
