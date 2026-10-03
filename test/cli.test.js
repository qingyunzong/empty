import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const INSTRUMENTS = JSON.stringify({
  trusted_institutions: ['NIM'],
  instrument_types: { torque_wrench: { calibration_interval_months: 12 } },
  instruments: [{ id: 'TW-1', type: 'torque_wrench' }],
});

function fixture(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'metro-'));
  writeFileSync(path.join(dir, 'instruments.json'), files.instruments ?? INSTRUMENTS);
  writeFileSync(path.join(dir, 'calibrations.jsonl'), files.calibrations ?? '');
  writeFileSync(path.join(dir, 'usage.jsonl'), files.usage ?? '');
  return dir;
}

// NOTE: this sandbox swallows piped stdout of node child processes, so the
// child's stdout/stderr are redirected to files and read back.
function runCli(args, dir) {
  const outFile = path.join(dir, '.stdout.log');
  const errFile = path.join(dir, '.stderr.log');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    stdio: ['ignore', outFd, errFd],
  });
  closeSync(outFd);
  closeSync(errFd);
  return {
    status: r.status,
    stdout: readFileSync(outFile, 'utf8'),
    stderr: readFileSync(errFile, 'utf8'),
  };
}

test('run writes status.json and impact.jsonl with correct semantics', () => {
  const dir = fixture({
    calibrations: [
      JSON.stringify({ event: 'issue', cert: 'C1', instrument: 'TW-1', institution: 'NIM', level: 1, issued: '2024-01-01' }),
      JSON.stringify({ event: 'revoke', cert: 'C1', date: '2024-06-01' }),
    ].join('\n') + '\n',
    usage: JSON.stringify({ work_order: 'WO-1', measurement: 'M1', instrument: 'TW-1', date: '2024-03-01' }) + '\n',
  });
  const r = runCli(['run', '--as-of', '2024-08-01'], dir);
  assert.equal(r.status, 0, r.stderr);

  const status = JSON.parse(readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.as_of, '2024-08-01');
  assert.deepEqual(status.usable_instruments, []);
  assert.equal(status.instruments[0].usable, false);
  assert.deepEqual(status.work_orders, [{ id: 'WO-1', status: 'retest_required' }]);

  const impact = readFileSync(path.join(dir, 'impact.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(impact[0].type, 'measurement');
  assert.equal(impact[0].status, 'pending_retest');
  assert.deepEqual(impact[0].certs, ['C1']);
  assert.deepEqual(impact[1], { type: 'work_order', id: 'WO-1', status: 'retest_required' });
});

test('counterexample prints the minimal revocation set', () => {
  const dir = fixture({
    calibrations: JSON.stringify({ event: 'issue', cert: 'C1', instrument: 'TW-1', institution: 'NIM', level: 1, issued: '2024-01-01' }) + '\n',
    usage: JSON.stringify({ work_order: 'WO-1', measurement: 'M1', instrument: 'TW-1', date: '2024-03-01' }) + '\n',
  });
  const r = runCli(['counterexample', '--work-order', 'WO-1', '--as-of', '2024-08-01'], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.minimal_revocations, ['C1']);
  assert.equal(out.size, 1);
});

test('exit 25 on invalid dates', () => {
  const bad = fixture({
    calibrations: JSON.stringify({ event: 'issue', cert: 'C1', instrument: 'TW-1', institution: 'NIM', issued: '2023-02-29' }) + '\n',
  });
  assert.equal(runCli(['run', '--as-of', '2024-08-01'], bad).status, 25);

  const badUsage = fixture({
    calibrations: '',
    usage: JSON.stringify({ work_order: 'WO-1', instrument: 'TW-1', date: '2024-13-40' }) + '\n',
  });
  assert.equal(runCli(['run'], badUsage).status, 25);

  const ok = fixture({});
  assert.equal(runCli(['run', '--as-of', 'not-a-date'], ok).status, 25);
});

test('exit 26 on untrusted institution', () => {
  const dir = fixture({
    calibrations: JSON.stringify({ event: 'issue', cert: 'C1', instrument: 'TW-1', institution: 'ACME-LAB', issued: '2024-01-01' }) + '\n',
  });
  const r = runCli(['run', '--as-of', '2024-08-01'], dir);
  assert.equal(r.status, 26);
  assert.match(r.stderr, /untrusted institution/);
});

test('exit 27 on restore chain self-reference (direct and cyclic)', () => {
  const base = [
    JSON.stringify({ event: 'issue', cert: 'C1', instrument: 'TW-1', institution: 'NIM', level: 1, issued: '2024-01-01' }),
    JSON.stringify({ event: 'issue', cert: 'C2', instrument: 'TW-1', institution: 'NIM', level: 2, issued: '2024-01-01' }),
    JSON.stringify({ event: 'issue', cert: 'C3', instrument: 'TW-1', institution: 'NIM', level: 3, issued: '2024-01-01' }),
  ];
  const direct = fixture({
    calibrations: [...base, JSON.stringify({ event: 'restore', cert: 'C1', by: 'C1', date: '2024-06-01' })].join('\n') + '\n',
  });
  assert.equal(runCli(['run', '--as-of', '2024-08-01'], direct).status, 27);

  const cyclic = fixture({
    calibrations: [
      ...base,
      JSON.stringify({ event: 'restore', cert: 'C1', by: 'C2', date: '2024-06-01' }),
      JSON.stringify({ event: 'restore', cert: 'C2', by: 'C3', date: '2024-06-02' }),
      JSON.stringify({ event: 'restore', cert: 'C3', by: 'C1', date: '2024-06-03' }),
    ].join('\n') + '\n',
  });
  assert.equal(runCli(['run', '--as-of', '2024-08-01'], cyclic).status, 27);
});

test('exit 1 (not 25/26/27) for restore policy violations', () => {
  const base = [
    JSON.stringify({ event: 'issue', cert: 'C1', instrument: 'TW-1', institution: 'NIM', level: 2, issued: '2024-01-01' }),
    JSON.stringify({ event: 'issue', cert: 'C2', instrument: 'TW-1', institution: 'NIM', level: 1, issued: '2024-01-01' }),
  ];
  const dir = fixture({
    calibrations: [...base, JSON.stringify({ event: 'restore', cert: 'C1', by: 'C2', date: '2024-06-01' })].join('\n') + '\n',
  });
  const r = runCli(['run', '--as-of', '2024-08-01'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /level/);
});
