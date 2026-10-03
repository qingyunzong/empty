import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import {
  run,
  createState,
  applyDeltas,
  rollback,
  collectRows,
  parseRollbackSpec,
  CyclicParentError,
} from '../lib/recon.js';

const CONFIRMED = [
  { target: '2024-01-01', amount: 1000 },
  { target: '2024-01-01/M001', amount: 600 },
  { target: '2024-01-01/M001/T001', amount: 300 },
  { target: '2024-01-01/M001/T002', amount: 300 },
];

function headAmount(rows, target) {
  const versions = rows.filter((r) => r.target === target && r.version != null);
  return versions[versions.length - 1].amount;
}

function baseAmount(target) {
  return CONFIRMED.find((r) => r.target === target).amount;
}

const DELTAS = [
  { scope: 'day', target: '2024-01-01', amount: 50, eventTime: '2024-01-02T00:00:00Z', seq: 1 },
  { scope: 'mch', target: '2024-01-01/M001', amount: 20, eventTime: '2024-01-02T00:01:00Z', seq: 1 },
  { scope: 'txn', target: '2024-01-01/M001/T001', amount: 5, eventTime: '2024-01-02T00:02:00Z', seq: 1 },
];

test('A: three-level rollback restores original snapshot', () => {
  const rows = run({
    confirmedRows: CONFIRMED,
    deltaRows: DELTAS,
    rollbacks: [{ level: 'day', target: '2024-01-01', version: null }],
  });
  for (const { target } of CONFIRMED) {
    assert.equal(headAmount(rows, target), baseAmount(target), `head of ${target}`);
  }
  const rolledBack = rows.filter((r) => r.status === 'rolled_back');
  assert.equal(rolledBack.length, CONFIRMED.length);
  // audit trail: corrections are preserved, not deleted
  assert.ok(rows.some((r) => r.status === 'corrected' && r.target === '2024-01-01'));
});

test('A: rollback(txn) does not touch sibling transactions', () => {
  const rows = run({
    confirmedRows: CONFIRMED,
    deltaRows: DELTAS,
    rollbacks: [{ level: 'txn', target: '2024-01-01/M001/T001', version: null }],
  });
  assert.equal(headAmount(rows, '2024-01-01/M001/T001'), 300);
  assert.equal(headAmount(rows, '2024-01-01/M001/T002'), 300);
  assert.equal(rows.filter((r) => r.target === '2024-01-01/M001/T002').length, 1);
  assert.equal(headAmount(rows, '2024-01-01'), 1050);
  assert.equal(headAmount(rows, '2024-01-01/M001'), 620);
});

test('A: rollback(mch) cascades to its txns but not the day', () => {
  const rows = run({
    confirmedRows: CONFIRMED,
    deltaRows: DELTAS,
    rollbacks: [{ level: 'mch', target: '2024-01-01/M001', version: null }],
  });
  assert.equal(headAmount(rows, '2024-01-01/M001'), 600);
  assert.equal(headAmount(rows, '2024-01-01/M001/T001'), 300);
  assert.equal(headAmount(rows, '2024-01-01'), 1050);
});

test('B: delta on locked snapshot goes to pending', () => {
  const rows = run({
    confirmedRows: [{ target: '2024-01-01', amount: 1000, locked: true }],
    deltaRows: [{ scope: 'day', target: '2024-01-01', amount: 50, eventTime: '2024-01-02T00:00:00Z', seq: 1 }],
  });
  const pending = rows.filter((r) => r.status === 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].target, '2024-01-01');
  assert.equal(rows.filter((r) => r.target === '2024-01-01' && r.version != null).length, 1);
});

test('B: delta past watermark goes to pending', () => {
  const rows = run({
    confirmedRows: [{ target: '2024-01-01', amount: 1000 }],
    deltaRows: [
      { scope: 'day', target: '2024-01-01', amount: 50, eventTime: '2024-01-02T00:00:00Z', seq: 1 },
      { scope: 'day', target: '2024-01-01', amount: 70, eventTime: '2024-01-05T00:00:00Z', seq: 1 },
    ],
    watermark: '2024-01-03T00:00:00Z',
  });
  assert.equal(headAmount(rows, '2024-01-01'), 1050);
  assert.equal(rows.filter((r) => r.status === 'pending').length, 1);
});

test('C: tied deltas are all emitted with status TIE', () => {
  const rows = run({
    confirmedRows: [{ target: '2024-01-01', amount: 100 }],
    deltaRows: [
      { scope: 'day', target: '2024-01-01', amount: 10, eventTime: '2024-01-02T00:00:00Z', seq: 1 },
      { scope: 'day', target: '2024-01-01', amount: 20, eventTime: '2024-01-02T00:00:00Z', seq: 1 },
    ],
  });
  const ties = rows.filter((r) => r.status === 'TIE');
  assert.equal(ties.length, 2);
  assert.deepEqual(ties.map((r) => r.amount), [110, 130]);
});

test('C: ordering by (eventTime, seq) is respected', () => {
  const rows = run({
    confirmedRows: [{ target: '2024-01-01', amount: 0 }],
    deltaRows: [
      { scope: 'day', target: '2024-01-01', amount: 100, eventTime: '2024-01-02T00:00:00Z', seq: 2 },
      { scope: 'day', target: '2024-01-01', amount: 1, eventTime: '2024-01-02T00:00:00Z', seq: 1 },
      { scope: 'day', target: '2024-01-01', amount: 1000, eventTime: '2024-01-01T00:00:00Z', seq: 9 },
    ],
  });
  const corrected = rows.filter((r) => r.status === 'corrected');
  assert.deepEqual(corrected.map((r) => r.amount), [1000, 1001, 1101]);
});

test('D: enumerate scope combos (<=80 deltas) and cross-check against reference', () => {
  const scopes = ['day', 'mch', 'txn'];
  const targetFor = { day: '2024-01-01', mch: '2024-01-01/M001', txn: '2024-01-01/M001/T001' };
  const base = { day: 1000, mch: 600, txn: 300 };
  let totalDeltas = 0;
  for (let n = 1; n <= 3; n++) {
    const combos = Array.from({ length: scopes.length ** n }, (_, i) =>
      Array.from({ length: n }, (_, k) => scopes[Math.floor(i / scopes.length ** k) % scopes.length]),
    );
    for (const combo of combos) {
      totalDeltas += combo.length;
      assert.ok(combo.length <= 80);
      const deltas = combo.map((scope, i) => ({
        scope,
        target: targetFor[scope],
        amount: (i + 1) * 7,
        eventTime: `2024-01-02T00:00:0${i}Z`,
        seq: 1,
      }));
      const rows = run({ confirmedRows: CONFIRMED, deltaRows: deltas });
      // independent reference: sum of amounts per scope, in input order
      const expected = { ...base };
      for (const d of deltas) expected[d.scope] += d.amount;
      for (const scope of scopes) {
        assert.equal(headAmount(rows, targetFor[scope]), expected[scope], `combo ${combo}`);
      }
      // full rollback restores base for every combo
      const restored = run({
        confirmedRows: CONFIRMED,
        deltaRows: deltas,
        rollbacks: [{ level: 'day', target: '2024-01-01', version: null }],
      });
      for (const { target, amount } of CONFIRMED) {
        assert.equal(headAmount(restored, target), amount, `rollback of combo ${combo}`);
      }
    }
  }
  assert.ok(totalDeltas <= 80 * 39, 'enumeration stays bounded');
});

test('rollback to missing version yields NO_VERSION', () => {
  const rows = run({
    confirmedRows: CONFIRMED,
    deltaRows: [],
    rollbacks: [{ level: 'day', target: '2024-01-01', version: 99 }],
  });
  const noVersion = rows.filter((r) => r.status === 'NO_VERSION');
  assert.ok(noVersion.length >= 1);
  assert.ok(noVersion.some((r) => r.target === '2024-01-01'));
});

test('rollback of unknown target yields NO_VERSION', () => {
  const rows = run({
    confirmedRows: CONFIRMED,
    deltaRows: [],
    rollbacks: [{ level: 'txn', target: '2024-01-01/M001/T009', version: null }],
  });
  assert.equal(rows.filter((r) => r.status === 'NO_VERSION').length, 1);
});

test('parseRollbackSpec validates input', () => {
  assert.deepEqual(parseRollbackSpec('day:2024-01-01'), {
    level: 'day',
    target: '2024-01-01',
    version: null,
  });
  assert.deepEqual(parseRollbackSpec('txn:2024-01-01/M001/T001@2'), {
    level: 'txn',
    target: '2024-01-01/M001/T001',
    version: 2,
  });
  assert.throws(() => parseRollbackSpec('bogus'));
});

test('cyclic parent chain throws CyclicParentError', () => {
  assert.throws(
    () =>
      createState([
        { target: '2024-01-01', amount: 1, version: 1, parent: 2 },
        { target: '2024-01-01', amount: 2, version: 2, parent: 1 },
      ]),
    CyclicParentError,
  );
});

test('CLI: cyclic parent exits with code 6', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recon-'));
  writeFileSync(
    join(dir, 'c.jsonl'),
    '{"target":"2024-01-01","amount":1,"version":1,"parent":2}\n{"target":"2024-01-01","amount":2,"version":2,"parent":1}\n',
  );
  writeFileSync(join(dir, 'd.jsonl'), '');
  let stderr = '';
  const code = runCli(['recon', '--base', join(dir, 'c.jsonl'), '--deltas', join(dir, 'd.jsonl')], {
    stdout: () => {},
    stderr: (s) => {
      stderr += s;
    },
  });
  assert.equal(code, 6);
  assert.match(stderr, /cyclic parent/i);
});

test('CLI: end-to-end recon with rollback writes versions.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recon-'));
  writeFileSync(join(dir, 'c.jsonl'), CONFIRMED.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(dir, 'd.jsonl'), DELTAS.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const out = join(dir, 'versions.jsonl');
  const code = runCli(
    ['recon', '--base', join(dir, 'c.jsonl'), '--deltas', join(dir, 'd.jsonl'), '--rollback', 'day:2024-01-01', '--out', out],
    { stdout: () => {}, stderr: () => {} },
  );
  assert.equal(code, 0);
  const rows = readFileSync(out, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['amount', 'level', 'parent', 'status', 'target', 'version']);
  }
  for (const { target, amount } of CONFIRMED) {
    assert.equal(headAmount(rows, target), amount);
  }
});

test('delta on unknown target goes to pending', () => {
  const state = createState(CONFIRMED);
  applyDeltas(state, [
    { scope: 'txn', target: '2024-01-01/M002/T001', amount: 5, eventTime: '2024-01-02T00:00:00Z', seq: 1 },
  ]);
  const rows = collectRows(state);
  assert.equal(rows.filter((r) => r.status === 'pending').length, 1);
});

test('rollback to explicit version restores that version amount', () => {
  const state = createState(CONFIRMED);
  applyDeltas(state, DELTAS);
  rollback(state, [{ level: 'txn', target: '2024-01-01/M001/T001', version: 1 }]);
  const rows = collectRows(state);
  assert.equal(headAmount(rows, '2024-01-01/M001/T001'), 300);
  assert.equal(headAmount(rows, '2024-01-01'), 1050);
});
