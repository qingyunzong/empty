import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, tmpdir, inputFile } from './helpers/cli.js';

const hold = (id, ts, extra = {}) => ({ id, ts, device: 'qc-1', lot: 'L1', kind: 'quality.hold', payload: { reason: 'suspect' }, ...extra });
const release = (id, ts, extra = {}) => ({ id, ts, device: 'qc-1', lot: 'L1', kind: 'quality.release', payload: { by: 'operator-7' }, ...extra });
const checkFail = (id, ts, extra = {}) => ({ id, ts, device: 'qc-1', lot: 'L1', kind: 'quality.check', payload: { result: 'fail', metric: 'dimension' }, ...extra });

function ingest(dir, events, env) {
  return runCli(['ingest', '--dir', dir, '--file', inputFile(events)], { env });
}

function cert(dir, lot = 'L1') {
  const r = runCli(['cert', '--dir', dir, '--lot', lot]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('concurrent manual release vs auto out-of-tolerance: hold wins, cert explains', () => {
  for (const order of ['release-first', 'check-first']) {
    const dir = tmpdir();
    const h = hold('h', 1000);
    const r = release('r', 2000, { parents: ['h'] });
    const c = checkFail('c', 3000, { parents: ['h'] });
    const events = order === 'release-first' ? [h, r, c] : [h, c, r];
    const res = ingest(dir, events);
    assert.equal(res.status, 0, `${order}: ${res.stderr}`);
    const c1 = cert(dir);
    assert.equal(c1.status, 'locked', order);
    assert.equal(c1.quality, 'hold', order);
    assert.deepEqual(c1.overridden, [{ event: 'r', by: 'c' }], order);
    assert.match(c1.explanation, /LOCKED/, order);
    assert.match(c1.explanation, /auto out-of-tolerance/, order);
    assert.match(c1.explanation, /r overridden by c/, order);
  }
});

test('out-of-tolerance causally after release is VALIDATION, not a conflict', () => {
  const dir = tmpdir();
  const res = ingest(dir, [
    hold('h', 1000),
    release('r', 2000, { parents: ['h'] }),
    checkFail('c', 3000, { parents: ['r'] }),
  ]);
  assert.equal(res.status, 2);
  const err = JSON.parse(res.stderr);
  assert.equal(err.code, 2);
  assert.equal(err.error, 'VALIDATION');
  const c1 = cert(dir);
  assert.equal(c1.quality, 'released');
});

test('release causally after auto hold is a normal acknowledgement', () => {
  const dir = tmpdir();
  const res = ingest(dir, [
    hold('h', 1000),
    checkFail('c', 2000, { parents: ['h'] }),
    release('r', 3000, { parents: ['h', 'c'] }),
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(cert(dir).quality, 'released');
});

test('unknown ancestor goes to pending, never fails; resolves when ancestor arrives', () => {
  const dir = tmpdir();
  let res = ingest(dir, [release('x', 1000, { parents: ['ghost'] })]);
  assert.equal(res.status, 0, res.stderr);
  let report = JSON.parse(res.stdout);
  assert.deepEqual(report.pending, ['x']);
  assert.equal(cert(dir).status, 'pending');

  res = ingest(dir, [hold('ghost', 500)]);
  assert.equal(res.status, 0, res.stderr);
  report = JSON.parse(res.stdout);
  assert.deepEqual(report.pending, []);
  const c1 = cert(dir);
  assert.equal(c1.quality, 'released');
  assert.deepEqual(c1.applied.sort(), ['ghost', 'x']);
});

test('causal cycle goes to pending, never fails', () => {
  const dir = tmpdir();
  const a = hold('a', 1000, { parents: ['b'] });
  const b = { id: 'b', ts: 2000, device: 'qc-1', lot: 'L1', kind: 'device.alarm', payload: {}, parents: ['a'] };
  const res = ingest(dir, [a, b]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.pending.sort(), ['a', 'b']);
  const c1 = cert(dir);
  assert.equal(c1.status, 'pending');
  assert.equal(c1.pending.length, 2);
});

test('bidirectional sync converges conflicting lots to locked on both sides', () => {
  const edge = tmpdir();
  const trace = tmpdir();
  // shared history
  let res = ingest(edge, [hold('h', 1000)]);
  assert.equal(res.status, 0, res.stderr);
  res = runCli(['sync', '--dir', edge, '--remote', trace]);
  assert.equal(res.status, 0, res.stderr);
  // diverge concurrently: operator releases on edge, auto check fails on traceability side
  res = ingest(edge, [release('r', 2000, { parents: ['h'] })]);
  assert.equal(res.status, 0, res.stderr);
  res = ingest(trace, [checkFail('c', 2000, { parents: ['h'] })]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(cert(edge).quality, 'released');
  assert.equal(cert(trace).quality, 'hold');
  // sync again: both must converge to locked/hold with the same explanation
  res = runCli(['sync', '--dir', edge, '--remote', trace]);
  assert.equal(res.status, 0, res.stderr);
  const syncReport = JSON.parse(res.stdout);
  assert.equal(syncReport.pulled, 1);
  assert.equal(syncReport.pushed, 1);
  for (const dir of [edge, trace]) {
    const c1 = cert(dir);
    assert.equal(c1.status, 'locked');
    assert.equal(c1.quality, 'hold');
    assert.deepEqual(c1.overridden, [{ event: 'r', by: 'c' }]);
  }
});

test('pending event resolved by ancestor arriving via sync', () => {
  const edge = tmpdir();
  const trace = tmpdir();
  let res = ingest(edge, [release('x', 2000, { parents: ['ghost'] })]);
  assert.equal(res.status, 0, res.stderr);
  res = ingest(trace, [hold('ghost', 1000)]);
  assert.equal(res.status, 0, res.stderr);
  res = runCli(['sync', '--dir', edge, '--remote', trace]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(cert(edge).quality, 'released');
  assert.equal(cert(trace).quality, 'released');
});
