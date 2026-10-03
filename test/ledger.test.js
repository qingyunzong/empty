'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildReport, verifyReport, hash, canonical } = require('../src/ledger');
const { main, EXIT_OK, EXIT_TAMPERED } = require('../cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elc-'));
}

function writeJsonl(dir, events) {
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function runCli(argv) {
  const out = [];
  const err = [];
  const status = main(argv, { stdout: (m) => out.push(m), stderr: (m) => err.push(m) });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

const OPTS = { windowSize: 10, lateness: 0 };

function sampleEvents() {
  return [
    { seq: 1, eventTime: 0, type: 'append', acct: 'A', amount: 100, ref: null },
    { seq: 2, eventTime: 1, type: 'append', acct: 'A', amount: 50, ref: null },
    { seq: 3, eventTime: 12, type: 'append', acct: 'B', amount: 20, ref: null },
    { seq: 4, eventTime: 13, type: 'correct', acct: 'A', amount: 70, ref: 1 },
  ];
}

test('A: normal chain builds and verifies', () => {
  const report = buildReport(sampleEvents(), OPTS);
  assert.equal(report.windows.length, 2);
  assert.deepEqual(report.windows[0].totals, { A: 150 });
  assert.deepEqual(report.windows[1].totals, { A: -30, B: 20 });
  assert.equal(report.appendix.length, 0);
  assert.match(report.root, /^[0-9a-f]{64}$/);
  const result = verifyReport(report);
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

test('A: CLI build + verify round trip exits 0', () => {
  const dir = tmpdir();
  const input = writeJsonl(dir, sampleEvents());
  const out = path.join(dir, 'r.json');
  const build = runCli(['audit', 'build', '--in', input, '--out', out, '--window-size', '10']);
  assert.equal(build.status, EXIT_OK, build.stderr);
  const verify = runCli(['audit', 'verify', '--in', out]);
  assert.equal(verify.status, EXIT_OK, verify.stderr);
  assert.match(verify.stdout, /OK/);
});

test('B: tampered amount fails verify with exit 4 and locates the window', () => {
  const dir = tmpdir();
  const input = writeJsonl(dir, sampleEvents());
  const out = path.join(dir, 'r.json');
  assert.equal(runCli(['audit', 'build', '--in', input, '--out', out, '--window-size', '10']).status, EXIT_OK);

  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  report.windows[0].events[0].amount = 999;
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  const verify = runCli(['audit', 'verify', '--in', out]);
  assert.equal(verify.status, EXIT_TAMPERED, verify.stderr);
  assert.match(verify.stderr, /window 0/);
});

test('B: tampered root alone fails verify', () => {
  const report = buildReport(sampleEvents(), OPTS);
  report.root = '0'.repeat(64);
  const result = verifyReport(report);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.where === 'root'));
});

test('B: tampered totals and tampered appendix are detected', () => {
  const report = buildReport(sampleEvents(), OPTS);
  const t1 = JSON.parse(JSON.stringify(report));
  t1.windows[0].totals.A = 1;
  assert.equal(verifyReport(t1).ok, false);

  const t2 = JSON.parse(JSON.stringify(report));
  t2.windows[1].events[1].applied = false;
  const r2 = verifyReport(t2);
  assert.equal(r2.ok, false);
  assert.ok(r2.failures.some((f) => f.where === 'window 1'));
});

test('C: correct arriving after its window is sealed goes to appendix', () => {
  const events = [
    { seq: 1, eventTime: 0, type: 'append', acct: 'A', amount: 100, ref: null },
    { seq: 2, eventTime: 25, type: 'append', acct: 'B', amount: 5, ref: null },
    { seq: 3, eventTime: 5, type: 'correct', acct: 'A', amount: 0, ref: 1 },
  ];
  const report = buildReport(events, OPTS);
  assert.equal(report.appendix.length, 1);
  assert.equal(report.appendix[0].reason, 'SEALED_WINDOW');
  assert.equal(report.appendix[0].event.seq, 3);
  assert.deepEqual(report.windows[0].totals, { A: 100 });
  assert.equal(verifyReport(report).ok, true);
});

test('C: lateness keeps window open for late events within the watermark', () => {
  const events = [
    { seq: 1, eventTime: 0, type: 'append', acct: 'A', amount: 100, ref: null },
    { seq: 2, eventTime: 25, type: 'append', acct: 'B', amount: 5, ref: null },
    { seq: 3, eventTime: 5, type: 'correct', acct: 'A', amount: 40, ref: 1 },
  ];
  const report = buildReport(events, { windowSize: 10, lateness: 20 });
  assert.equal(report.appendix.length, 0);
  assert.deepEqual(report.windows[0].totals, { A: 40 });
  assert.equal(verifyReport(report).ok, true);
});

test('D: --naive cross-check passes for <=150 events with version chains', () => {
  const events = [];
  let seq = 0;
  for (let i = 0; i < 40; i += 1) {
    seq += 1;
    events.push({ seq, eventTime: i * 3, type: 'append', acct: `acct${i % 5}`, amount: (i * 37) % 101, ref: null });
    if (i % 3 === 0) {
      seq += 1;
      events.push({ seq, eventTime: i * 3 + 1, type: 'correct', acct: `acct${i % 5}`, amount: i, ref: seq - 1 });
    }
    if (i % 7 === 0) {
      seq += 1;
      events.push({ seq, eventTime: i * 3 + 2, type: 'correct', acct: `acct${i % 5}`, amount: 0, ref: seq - 2 });
    }
  }
  assert.ok(events.length <= 150);
  const report = buildReport(events, { ...OPTS, naive: true });
  assert.equal(verifyReport(report).ok, true);

  const dir = tmpdir();
  const input = writeJsonl(dir, events);
  const out = path.join(dir, 'r.json');
  const build = runCli(['audit', 'build', '--in', input, '--out', out, '--window-size', '10', '--naive']);
  assert.equal(build.status, EXIT_OK, build.stderr);
  assert.match(build.stdout, /naive cross-check: OK/);
});

test('D: --naive rejects more than 150 events', () => {
  const events = [];
  for (let seq = 1; seq <= 151; seq += 1) {
    events.push({ seq, eventTime: seq, type: 'append', acct: 'A', amount: 1, ref: null });
  }
  assert.throws(() => buildReport(events, { ...OPTS, naive: true }), /at most 150/);
});

test('dangling ref is recorded as DANGLING and processing continues', () => {
  const events = [
    { seq: 1, eventTime: 0, type: 'append', acct: 'A', amount: 100, ref: null },
    { seq: 2, eventTime: 1, type: 'correct', acct: 'A', amount: 0, ref: 99 },
    { seq: 3, eventTime: 2, type: 'append', acct: 'A', amount: 7, ref: null },
  ];
  const report = buildReport(events, OPTS);
  assert.deepEqual(report.errors, [{ seq: 2, code: 'DANGLING', ref: 99 }]);
  assert.equal(report.windows[0].events[1].applied, false);
  assert.deepEqual(report.windows[0].totals, { A: 107 });
  assert.equal(verifyReport(report).ok, true);
});

test('correct cannot point to a future ingest seq', () => {
  const events = [
    { seq: 1, eventTime: 0, type: 'correct', acct: 'A', amount: 0, ref: 5 },
    { seq: 5, eventTime: 1, type: 'append', acct: 'A', amount: 10, ref: null },
  ];
  const report = buildReport(events, OPTS);
  assert.deepEqual(report.errors, [{ seq: 1, code: 'FUTURE_REF', ref: 5 }]);
  assert.deepEqual(report.windows[0].totals, { A: 10 });
});

test('version chain: only the latest correct is effective', () => {
  const events = [
    { seq: 1, eventTime: 0, type: 'append', acct: 'A', amount: 100, ref: null },
    { seq: 2, eventTime: 1, type: 'correct', acct: 'A', amount: 30, ref: 1 },
    { seq: 3, eventTime: 2, type: 'correct', acct: 'A', amount: 0, ref: 1 },
  ];
  const report = buildReport(events, OPTS);
  assert.deepEqual(report.windows[0].totals, { A: 0 });
  assert.equal(report.windows[0].events.every((e) => e.applied), true);
  assert.equal(verifyReport(report).ok, true);
});

test('hash domains are separated for header, event and appendix', () => {
  const payload = canonical({ a: 1 });
  const h1 = hash('header', payload);
  const h2 = hash('event', payload);
  const h3 = hash('appendix', payload);
  assert.notEqual(h1, h2);
  assert.notEqual(h2, h3);
  assert.notEqual(h1, h3);
});

test('window headers are chained via prev hashes', () => {
  const report = buildReport(sampleEvents(), OPTS);
  assert.equal(report.windows[0].prev, '0'.repeat(64));
  assert.equal(report.windows[1].prev, report.windows[0].hash);
});
