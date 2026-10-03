'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { referenceWindows } = require('../src/reference');

const CLI = path.join(__dirname, '..', 'cli.js');
const RESULT_FILE = path.join(__dirname, '..', 'result.txt');
const records = [];

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wstats-${name}-`));
}

function runCli(args) {
  // The sandbox blocks node child processes from writing to inherited pipes,
  // so capture real stdout/stderr/exit code via files through bash.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  const out = path.join(tmp, 'out');
  const err = path.join(tmp, 'err');
  const code = path.join(tmp, 'code');
  spawnSync('bash', ['-c', '"$@" >"$OUT" 2>"$ERR"; printf %s "$?" >"$CODE"', '_',
    process.execPath, CLI, ...args], { env: { ...process.env, OUT: out, ERR: err, CODE: code } });
  return {
    stdout: fs.readFileSync(out, 'utf8'),
    stderr: fs.readFileSync(err, 'utf8'),
    code: Number(fs.readFileSync(code, 'utf8')),
  };
}

function record(scenario, label, args, res) {
  records.push({ scenario, label, cmd: `node cli.js ${args.join(' ')}`, ...res });
  return res;
}

function parseRows(stdout) {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertMatchesReference(rows, events, device) {
  const expected = referenceWindows(events, device, rows[0].window, rows[rows.length - 1].window + 900);
  assert.equal(rows.length, expected.length);
  for (let i = 0; i < rows.length; i += 1) {
    assert.equal(rows[i].window, expected[i].window);
    assert.equal(rows[i].uptime, expected[i].uptime, `window ${rows[i].window} uptime`);
    assert.equal(rows[i].downtime, expected[i].downtime, `window ${rows[i].window} downtime`);
    assert.equal(rows[i].unknown, expected[i].unknown, `window ${rows[i].window} unknown`);
    if (rows[i].uptime === null) {
      assert.equal(rows[i].unknown, 900);
    } else {
      assert.equal(rows[i].uptime + rows[i].downtime + rows[i].unknown, 900);
    }
  }
}

test('scenario 1: late down event splits an up window and corrects multiple buckets', () => {
  const dir = tmpdir('s1');
  const S = 'scenario-1';
  const up = { id: 'e1', device: 'A', ts: 2000, state: 'up' };
  const down = { id: 'e2', device: 'A', ts: 1500, state: 'down' };

  let r = record(S, 'append up@2000', ['append', '--dir', dir, '--event', JSON.stringify(up)],
    runCli(['append', '--dir', dir, '--event', JSON.stringify(up)]));
  assert.equal(r.code, 0);

  r = record(S, 'query before late event', ['query', '--dir', dir, '--device', 'A', '--from', '0', '--to', '3600'],
    runCli(['query', '--dir', dir, '--device', 'A', '--from', '0', '--to', '3600']));
  assert.equal(r.code, 0);
  let rows = parseRows(r.stdout);
  assertMatchesReference(rows, [up], 'A');
  assert.deepEqual(
    rows.map((x) => [x.window, x.uptime, x.downtime, x.unknown, x.version]),
    [[0, null, null, 900, 1], [900, null, null, 900, 1], [1800, 700, 0, 200, 1], [2700, 900, 0, 0, 1]],
  );

  // late event: ts=1500 is below the watermark (2000)
  r = record(S, 'append late down@1500', ['append', '--dir', dir, '--event', JSON.stringify(down)],
    runCli(['append', '--dir', dir, '--event', JSON.stringify(down)]));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /RETRACT device=A window=900 .* version=1/);
  assert.match(r.stdout, /CORRECT device=A window=900 .* version=2/);
  assert.match(r.stdout, /RETRACT device=A window=1800 .* version=1/);
  assert.match(r.stdout, /CORRECT device=A window=1800 .* version=2/);
  assert.doesNotMatch(r.stdout, /window=2700/); // unaffected bucket untouched

  r = record(S, 'query after correction', ['query', '--dir', dir, '--device', 'A', '--from', '0', '--to', '3600'],
    runCli(['query', '--dir', dir, '--device', 'A', '--from', '0', '--to', '3600']));
  assert.equal(r.code, 0);
  rows = parseRows(r.stdout);
  assertMatchesReference(rows, [up, down], 'A');
  assert.deepEqual(
    rows.map((x) => [x.window, x.uptime, x.downtime, x.unknown, x.version]),
    [[0, null, null, 900, 1], [900, 0, 300, 600, 2], [1800, 700, 200, 0, 2], [2700, 900, 0, 0, 1]],
  );
});

test('scenario 2: all windows before the first event are unknown', () => {
  const dir = tmpdir('s2');
  const S = 'scenario-2';
  const first = { id: 'e1', device: 'B', ts: 5000, state: 'up' };

  let r = record(S, 'append first event up@5000', ['append', '--dir', dir, '--event', JSON.stringify(first)],
    runCli(['append', '--dir', dir, '--event', JSON.stringify(first)]));
  assert.equal(r.code, 0);

  r = record(S, 'query windows before first event', ['query', '--dir', dir, '--device', 'B', '--from', '0', '--to', '2700'],
    runCli(['query', '--dir', dir, '--device', 'B', '--from', '0', '--to', '2700']));
  assert.equal(r.code, 0);
  const rows = parseRows(r.stdout);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.uptime, null);
    assert.equal(row.downtime, null);
    assert.equal(row.unknown, 900);
  }
  assertMatchesReference(rows, [first], 'B');
});

test('scenario 3: crash after append replays log; crash before append has no effect', () => {
  const dir = tmpdir('s3');
  const S = 'scenario-3';
  const e1 = { id: 'e1', device: 'C', ts: 100, state: 'up' };
  const e2 = { id: 'e2', device: 'C', ts: 400, state: 'down' };
  const e3 = { id: 'e3', device: 'C', ts: 700, state: 'up' };

  let r = record(S, 'append e1 up@100', ['append', '--dir', dir, '--event', JSON.stringify(e1)],
    runCli(['append', '--dir', dir, '--event', JSON.stringify(e1)]));
  assert.equal(r.code, 0);

  r = record(S, 'query publishes v1', ['query', '--dir', dir, '--device', 'C', '--from', '0', '--to', '1800'],
    runCli(['query', '--dir', dir, '--device', 'C', '--from', '0', '--to', '1800']));
  assert.equal(r.code, 0);

  // crash type 1: after log append, before index update
  r = record(S, 'append e2 down@400 (crash after append)', ['append', '--dir', dir, '--event', JSON.stringify(e2), '--fail-after-append'],
    runCli(['append', '--dir', dir, '--event', JSON.stringify(e2), '--fail-after-append']));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /crash after append/);

  // restart: query replays the log, recovers e2, and corrects the stale index
  r = record(S, 'query after crash-after-append (recovery)', ['query', '--dir', dir, '--device', 'C', '--from', '0', '--to', '1800'],
    runCli(['query', '--dir', dir, '--device', 'C', '--from', '0', '--to', '1800']));
  assert.equal(r.code, 0);
  assert.match(r.stderr, /CORRECT device=C window=0 .* version=2/);
  let rows = parseRows(r.stdout);
  assertMatchesReference(rows, [e1, e2], 'C');
  assert.deepEqual(
    rows.map((x) => [x.window, x.uptime, x.downtime, x.unknown, x.version]),
    [[0, 300, 500, 100, 2], [900, 0, 900, 0, 2]],
  );
  const recoveredStdout = r.stdout;

  // crash type 2: before log append -> batch has zero effect
  r = record(S, 'append e3 up@700 (crash before append)', ['append', '--dir', dir, '--event', JSON.stringify(e3), '--fail-before-append'],
    runCli(['append', '--dir', dir, '--event', JSON.stringify(e3), '--fail-before-append']));
  assert.equal(r.code, 3);
  assert.match(r.stderr, /crash before append/);

  r = record(S, 'query after crash-before-append (unchanged)', ['query', '--dir', dir, '--device', 'C', '--from', '0', '--to', '1800'],
    runCli(['query', '--dir', dir, '--device', 'C', '--from', '0', '--to', '1800']));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, recoveredStdout); // e3 never landed

  // compact keeps results identical
  r = record(S, 'compact log', ['compact', '--dir', dir], runCli(['compact', '--dir', dir]));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /compacted: batches=2 events_before=2 events_after=2/);

  r = record(S, 'query after compact (consistent)', ['query', '--dir', dir, '--device', 'C', '--from', '0', '--to', '1800'],
    runCli(['query', '--dir', dir, '--device', 'C', '--from', '0', '--to', '1800']));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, recoveredStdout);
});

test.after(() => {
  const parts = [];
  let current = null;
  for (const rec of records) {
    if (rec.scenario !== current) {
      current = rec.scenario;
      parts.push(`# ${current}\n`);
    }
    parts.push(`## ${rec.label}`);
    parts.push(`$ ${rec.cmd}`);
    parts.push(`exit code: ${rec.code}`);
    parts.push('--- stdout ---');
    parts.push(rec.stdout.trimEnd() || '(empty)');
    parts.push('--- stderr ---');
    parts.push(rec.stderr.trimEnd() || '(empty)');
    parts.push('');
  }
  fs.writeFileSync(RESULT_FILE, `${parts.join('\n')}\n`);
});
