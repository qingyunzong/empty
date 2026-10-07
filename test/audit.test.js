import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, verifyReport } from '../src/audit.js';
import { main } from '../cli.js';

function runCli(args) {
  const io = {
    stdout: '',
    stderr: '',
    log(s) { this.stdout += s + '\n'; },
    error(s) { this.stderr += s + '\n'; },
  };
  const status = main(args, io);
  return { status, stdout: io.stdout, stderr: io.stderr };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'audit-chain-'));
}

function writeJsonl(dir, events) {
  const p = join(dir, 'events.jsonl');
  writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

const ev = (seq, eventTime, type, acct, amount, ref = null) => ({
  seq,
  eventTime,
  type,
  acct,
  amount,
  ref,
});

test('A: normal chain builds and verifies (exit 0)', () => {
  const dir = tmp();
  const input = writeJsonl(dir, [
    ev(1, 100, 'append', 'A', 100),
    ev(2, 200, 'append', 'B', 50),
    ev(3, 300, 'correct', 'A', 80, 1),
    ev(4, 5000, 'append', 'C', 7),
  ]);
  const out = join(dir, 'report.json');
  const build = runCli(['audit', 'build', '--in', input, '--out', out, '--window-size', '1000']);
  assert.equal(build.status, 0, build.stderr);
  const verify = runCli(['audit', 'verify', '--in', out]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /verify OK/);
});

test('B: tampering an amount fails verify with exit 4 and locates the window', () => {
  const dir = tmp();
  const input = writeJsonl(dir, [
    ev(1, 100, 'append', 'A', 100),
    ev(2, 200, 'append', 'B', 50),
    ev(3, 1200, 'append', 'C', 9),
  ]);
  const out = join(dir, 'report.json');
  assert.equal(runCli(['audit', 'build', '--in', input, '--out', out, '--window-size', '1000']).status, 0);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  report.windows[0].events[0].amount = 101; // tamper
  writeFileSync(out, JSON.stringify(report, null, 2));
  const verify = runCli(['audit', 'verify', '--in', out]);
  assert.equal(verify.status, 4);
  assert.match(verify.stderr, /window\[0\] start=0/);
});

test('tampering the root fails verify with exit 4', () => {
  const dir = tmp();
  const input = writeJsonl(dir, [ev(1, 100, 'append', 'A', 100)]);
  const out = join(dir, 'report.json');
  assert.equal(runCli(['audit', 'build', '--in', input, '--out', out]).status, 0);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  report.root = report.root.replace(/^./, report.root[0] === 'a' ? 'b' : 'a');
  writeFileSync(out, JSON.stringify(report));
  const verify = runCli(['audit', 'verify', '--in', out]);
  assert.equal(verify.status, 4);
  assert.match(verify.stderr, /root mismatch/);
});

test('C: correct arriving after its window is sealed goes to appendix', () => {
  const report = buildReport(
    [
      ev(1, 100, 'append', 'A', 100),
      ev(2, 3000, 'append', 'B', 5), // advances watermark, seals window 0
      ev(3, 200, 'correct', 'A', 0, 1), // late: window 0 already sealed
    ],
    { windowSize: 1000, allowedLateness: 0 },
  );
  assert.equal(report.appendix.length, 1);
  assert.equal(report.appendix[0].reason, 'LATE_AFTER_SEAL');
  assert.equal(report.appendix[0].seq, 3);
  assert.equal(report.windows[0].netAmount, 100); // sealed window untouched
  assert.deepEqual(verifyReport(report), []);
});

test('late event within lateness still enters an unsealed window', () => {
  const report = buildReport(
    [
      ev(1, 100, 'append', 'A', 100),
      ev(2, 3000, 'append', 'B', 5), // watermark = 3000 - 5000 < 0, nothing sealed
      ev(3, 200, 'correct', 'A', 40, 1),
    ],
    { windowSize: 1000, allowedLateness: 5000 },
  );
  assert.equal(report.appendix.length, 0);
  assert.equal(report.windows[0].netAmount, 40);
  assert.deepEqual(verifyReport(report), []);
});

test('D: 120 events with --naive cross-check builds and verifies', () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const events = [];
  const appendSeqs = [];
  for (let i = 1; i <= 120; i += 1) {
    const t = i * 100 - Math.floor(rand() * 400); // mostly ordered, some lateness
    if (appendSeqs.length > 0 && rand() < 0.3) {
      const ref = appendSeqs[Math.floor(rand() * appendSeqs.length)];
      events.push(ev(i, t, 'correct', 'A', Math.floor(rand() * 200), ref));
    } else {
      events.push(ev(i, t, 'append', `acct${i % 7}`, Math.floor(rand() * 1000)));
      appendSeqs.push(i);
    }
  }
  assert.ok(events.length <= 150);
  const dir = tmp();
  const input = writeJsonl(dir, events);
  const out = join(dir, 'report.json');
  const build = runCli([
    'audit', 'build', '--in', input, '--out', out,
    '--window-size', '1000', '--lateness', '300', '--naive',
  ]);
  assert.equal(build.status, 0, build.stderr);
  const verify = runCli(['audit', 'verify', '--in', out]);
  assert.equal(verify.status, 0, verify.stderr);
});

test('dangling ref is recorded as DANGLING and build continues', () => {
  const report = buildReport(
    [
      ev(1, 100, 'append', 'A', 100),
      ev(2, 200, 'correct', 'A', 0, 999), // unknown ref
      ev(3, 300, 'append', 'B', 5),
    ],
    { windowSize: 1000 },
  );
  assert.deepEqual(report.errors, [{ seq: 2, code: 'DANGLING', ref: 999 }]);
  assert.equal(report.windows[0].netAmount, 105); // dangling correct contributes 0
  assert.deepEqual(verifyReport(report), []);
});

test('correct cannot point to a future ingestSeq', () => {
  const report = buildReport(
    [
      ev(1, 100, 'correct', 'A', 0, 3), // ref points to a future seq
      ev(2, 200, 'correct', 'A', 0, 2), // self ref
      ev(3, 300, 'append', 'A', 10),
    ],
    { windowSize: 1000 },
  );
  assert.deepEqual(
    report.errors.map((e) => e.code),
    ['DANGLING', 'DANGLING'],
  );
  assert.equal(report.windows[0].netAmount, 10);
  assert.deepEqual(verifyReport(report), []);
});

test('version chain: repeated corrects leave exactly one effective version', () => {
  const report = buildReport(
    [
      ev(1, 100, 'append', 'A', 100),
      ev(2, 200, 'correct', 'A', 30, 1),
      ev(3, 300, 'correct', 'A', 0, 1), // revoke
    ],
    { windowSize: 1000 },
  );
  // 100 + (30-100) + (0-30) = 0
  assert.equal(report.windows[0].netAmount, 0);
  assert.deepEqual(
    report.windows[0].events.map((e) => e.contribution),
    [100, -70, -30],
  );
  assert.deepEqual(verifyReport(report), []);
});

test('library verifyReport detects appendix tampering', () => {
  const report = buildReport(
    [
      ev(1, 100, 'append', 'A', 100),
      ev(2, 3000, 'append', 'B', 5),
      ev(3, 200, 'correct', 'A', 0, 1),
    ],
    { windowSize: 1000 },
  );
  report.appendix[0].amount = 999;
  const failures = verifyReport(report);
  assert.ok(failures.some((f) => f.includes('appendix[0]')));
});
