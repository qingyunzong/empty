import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { grossRequirements, referenceGross, netRequirements } from '../src/mrp.js';
import { applyEvents, query, listPaths, readLog, readSnapshot, StoreError } from '../src/store.js';
import { runCli } from '../src/cli.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-test-'));
}

function loadScenario(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', name), 'utf8'));
}

// Scenario 1 fixtures: two work orders sharing multi-level components.
const WORK_ORDERS = [
  { id: 'WO1', product: 'X', qty: 2 },
  { id: 'WO2', product: 'Y', qty: 5 },
];
const BOM = [
  { parent: 'X', component: 'M', usage: 2 },
  { parent: 'X', component: 'N', usage: 1 },
  { parent: 'Y', component: 'M', usage: 3 },
  { parent: 'M', component: 'P', usage: 4 },
  { parent: 'N', component: 'P', usage: 2 },
  { parent: 'P', component: 'Q', usage: 5 },
];
const EXPECTED_GROSS = { M: 19, N: 2, P: 80, Q: 400 };

test('scenario 1: relational expansion aggregates shared multi-level components', () => {
  const gross = grossRequirements(WORK_ORDERS, BOM);
  assert.deepEqual(Object.fromEntries(gross), EXPECTED_GROSS);
});

test('scenario 1: reference algorithm enumerates all paths and recomputes identical gross', () => {
  const { gross, paths } = referenceGross(WORK_ORDERS, BOM);
  assert.equal(paths.length, 3);
  const byOrderAndLeaf = paths.map((p) => ({ order: p.order, qty: p.qty, chain: p.edges.map((e) => e.component).join('>') }));
  assert.deepEqual(byOrderAndLeaf, [
    { order: 'WO1', qty: 20, chain: 'N>P>Q' },
    { order: 'WO1', qty: 80, chain: 'M>P>Q' },
    { order: 'WO2', qty: 300, chain: 'M>P>Q' },
  ]);
  assert.deepEqual(Object.fromEntries(gross), EXPECTED_GROSS);
  assert.deepEqual(Object.fromEntries(gross), Object.fromEntries(grossRequirements(WORK_ORDERS, BOM)));
});

test('net requirements: unknown inventory stays null, never 0', () => {
  const gross = grossRequirements(WORK_ORDERS, BOM);
  const net = netRequirements(gross, [
    { component: 'M', qty: 10 },
    { component: 'P', qty: null },
    { component: 'Q', qty: 500 },
  ]);
  assert.equal(net.get('M'), 9);
  assert.equal(net.get('N'), null); // no inventory row -> unknown
  assert.equal(net.get('P'), null); // qty null -> unknown
  assert.equal(net.get('Q'), 0); // fully covered
});

test('scenario 2: correcting inventory null -> 0 turns net from null into a shortage', () => {
  const dir = tmpDir();
  applyEvents(dir, loadScenario('s2a.json'));
  const before = query(dir);
  assert.equal(before.version, 1);
  assert.equal(before.net.P, null);
  assert.equal(before.gross.P, 16);

  applyEvents(dir, loadScenario('s2b.json'));
  const after = query(dir);
  assert.equal(after.version, 2);
  assert.equal(after.net.P, 16);
  assert.deepEqual(after.delta.P, { previous: null, current: 16, delta: null });
  assert.deepEqual(after.delta.M, { previous: null, current: null, delta: null });
});

test('scenario 2: correcting an unknown key fails and persists nothing', () => {
  const dir = tmpDir();
  applyEvents(dir, loadScenario('s2a.json'));
  assert.throws(() => applyEvents(dir, loadScenario('s2bad.json')), StoreError);
  assert.throws(
    () => applyEvents(dir, loadScenario('s2bad.json')),
    /correct unknown key on inventory: \["ZZZ"\]/,
  );
  assert.equal(readLog(dir).length, 1);
  assert.equal(query(dir).version, 1);
});

test('corrections undo old values by key and are journaled with prev record', () => {
  const dir = tmpDir();
  applyEvents(dir, [
    { op: 'insert', table: 'work_order', record: { id: 'W1', product: 'X', qty: 1 } },
    { op: 'insert', table: 'bom', record: { parent: 'X', component: 'M', usage: 2 } },
    { op: 'insert', table: 'inventory', record: { component: 'M', qty: 5 } },
  ]);
  applyEvents(dir, [
    { op: 'correct', table: 'work_order', record: { id: 'W1', product: 'X', qty: 10 } },
  ]);
  const log = readLog(dir);
  assert.equal(log.length, 2);
  assert.deepEqual(log[1].events[0].prev, { id: 'W1', product: 'X', qty: 1 });
  assert.equal(query(dir).gross.M, 20);
  assert.equal(query(dir).net.M, 15);
  // delete removes the requirement again
  applyEvents(dir, [{ op: 'delete', table: 'work_order', key: { id: 'W1' } }]);
  const after = query(dir);
  assert.equal(after.version, 3);
  assert.deepEqual(after.gross, {});
  assert.deepEqual(after.delta.M, { previous: 15, current: null, delta: null });
});

test('scenario 3: --fail before_append leaves no trace', () => {
  const dir = tmpDir();
  applyEvents(dir, loadScenario('s3a.json'));
  assert.throws(
    () => applyEvents(dir, loadScenario('s3b.json'), { fail: 'before_append' }),
    /injected failure before_append/,
  );
  assert.equal(readLog(dir).length, 1);
  assert.equal(readSnapshot(dir).version, 1);
  const report = query(dir);
  assert.equal(report.version, 1);
  assert.equal(report.recovered, false);
  assert.equal(report.net.M, null);
});

test('scenario 3: --fail after_append persists the log; restart query recovers by replay', () => {
  const dir = tmpDir();
  applyEvents(dir, loadScenario('s3a.json'));
  assert.throws(
    () => applyEvents(dir, loadScenario('s3b.json'), { fail: 'after_append' }),
    /injected failure after_append/,
  );
  // log has the event, snapshot does not
  assert.equal(readLog(dir).length, 2);
  assert.equal(readSnapshot(dir).version, 1);
  // restart: query recovers via replay
  const report = query(dir);
  assert.equal(report.version, 2);
  assert.equal(report.recovered, true);
  assert.equal(report.snapshot_version, 1);
  assert.equal(report.gross.M, 6);
  assert.equal(report.net.M, 5);
  assert.deepEqual(report.delta.M, { previous: null, current: 5, delta: null });
  // a later clean apply catches the snapshot up
  applyEvents(dir, [{ op: 'correct', table: 'inventory', record: { component: 'M', qty: 4 } }]);
  const final = query(dir);
  assert.equal(final.version, 3);
  assert.equal(final.recovered, false);
  assert.equal(final.net.M, 2);
  assert.deepEqual(final.delta.M, { previous: 5, current: 2, delta: -3 });
});

test('query certificate is the sha256 of the append-only input log', () => {
  const dir = tmpDir();
  applyEvents(dir, loadScenario('s3a.json'));
  const first = query(dir);
  const expected = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'log.jsonl'))).digest('hex')}`;
  assert.equal(first.certificate, expected);
  applyEvents(dir, loadScenario('s3b.json'));
  assert.notEqual(query(dir).certificate, first.certificate);
});

test('CLI: success exits 0 with JSON, errors exit 1 with {"error": ...}', () => {
  const dir = tmpDir();
  const ok = runCli(['apply', path.join(ROOT, 'scenarios', 's2a.json'), '--data', dir]);
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(ok.stdout), { ok: true, version: 1, applied: 4 });

  const bad = runCli(['apply', path.join(ROOT, 'scenarios', 's2bad.json'), '--data', dir]);
  assert.equal(bad.code, 1);
  assert.match(JSON.parse(bad.stdout).error, /correct unknown key on inventory/);

  const report = runCli(['query', '--data', dir]);
  assert.equal(report.code, 0);
  assert.equal(JSON.parse(report.stdout).version, 1);
});

test('CLI: paths command enumerates reference paths for scenario 1', () => {
  const dir = tmpDir();
  runCli(['apply', path.join(ROOT, 'scenarios', 's1.json'), '--data', dir]);
  const out = runCli(['paths', '--data', dir]);
  assert.equal(out.code, 0);
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.count, 3);
  assert.deepEqual(parsed.reference_gross, EXPECTED_GROSS);
  const q = JSON.parse(runCli(['query', '--data', dir]).stdout);
  assert.deepEqual(q.gross, EXPECTED_GROSS);
  assert.deepEqual(q.reference_gross, EXPECTED_GROSS);
  assert.equal(q.net.M, 9);
  assert.equal(q.net.P, null);
  assert.equal(q.net.Q, 0);
});
