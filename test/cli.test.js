import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { main } from '../src/cli-main.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = (name) => path.join(rootDir, 'examples', name);

function runCli(args, stdinText = '') {
  let stdout = '';
  let stderr = '';
  const code = main(args, {
    stdout: (line) => { stdout += `${line}\n`; },
    stderr: (line) => { stderr += `${line}\n`; },
    readStdin: () => stdinText,
  });
  return { code, stdout, stderr };
}

test('CLI runs the borrow example and prints the report', () => {
  const res = runCli([example('borrow.json')]);
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.borrowChain.length, 1);
  assert.equal(report.borrowChain[0].lender, 'alpha');
  assert.equal(report.borrowChain[0].amount, 15);
  assert.equal(report.schedule.find((o) => o.id === 'b1').active, 25);
});

test('CLI runs the reclaim example with exact preemption', () => {
  const res = runCli([example('reclaim.json')]);
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.preemptions.length, 1);
  assert.equal(report.preemptions[0].amount, 10);
  assert.equal(report.reclaims[0].released, 10);
  assert.equal(report.schedule.find((o) => o.id === 'l1').status, 'scheduled');
  assert.equal(report.schedule.find((o) => o.id === 'b2').status, 'partial');
});

test('CLI runs the starvation example and blocks the borrow', () => {
  const res = runCli([example('starvation.json')]);
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.schedule.find((o) => o.id === 'b2').status, 'waiting');
  assert.equal(report.borrowChain.length, 1);
});

test('CLI --pretty prints indented JSON', () => {
  const res = runCli(['--pretty', example('borrow.json')]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /\n {2}"/);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, true);
});

test('CLI rejects a cyclic tenant tree', () => {
  const res = runCli([example('invalid-cycle.json')]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /CYCLE/);
});

test('CLI rejects negative quota', () => {
  const res = runCli([example('invalid-negative-quota.json')]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /NEGATIVE_QUOTA/);
});

test('CLI rejects children exceeding root capacity', () => {
  const res = runCli([example('invalid-root-cap.json')]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /ROOT_CAP_EXCEEDED/);
});

test('CLI --check validates without scheduling', () => {
  const ok = runCli(['--check', example('borrow.json')]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { ok: true });
  const bad = runCli(['--check', example('invalid-cycle.json')]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /CYCLE/);
});

test('CLI reads scenarios from stdin', () => {
  const scenario = JSON.stringify({
    tenants: [
      { id: 'root', parent: null, capacity: 5 },
      { id: 'a', parent: 'root', guarantee: 5 },
    ],
    orders: [{ id: 'o1', tenant: 'a', units: 3 }],
    commands: [{ cmd: 'tick', time: 0 }],
  });
  const res = runCli(['-'], scenario);
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.utilization.used, 3);
});

test('CLI reports invalid JSON and missing files', () => {
  const badJson = runCli(['-'], '{not json');
  assert.equal(badJson.code, 1);
  assert.match(badJson.stderr, /INVALID_JSON/);
  const missing = runCli([path.join(rootDir, 'examples', 'no-such-file.json')]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /error\[IO\]/);
});

test('CLI requires a scenario file argument', () => {
  const res = runCli([]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /usage:/);
});
