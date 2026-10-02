'use strict';

// CLI end-to-end: exit code 11 for checksum error / disk full / cyclic
// dependency; request/restore/correct/verify/undo round-trip via state file.
// The sandbox blocks child processes (spawnSync EPERM), so the CLI is driven
// in-process through its exported main() with captured stdio; the bin wrapper
// in lib/cli.js maps results to process exit codes identically.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../lib/cli.js');
const { ArchiveError, EXIT_ERROR_CODES } = require('../lib/archive.js');

function run(args) {
  let stdout = '';
  let stderr = '';
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  process.stdout.write = (s) => ((stdout += s), true);
  process.stderr.write = (s) => ((stderr += s), true);
  let status;
  try {
    status = main(args);
  } catch (err) {
    if (err instanceof ArchiveError) {
      stderr += JSON.stringify({ error: { code: err.code, message: err.message } });
      status = EXIT_ERROR_CODES.has(err.code) ? 11 : 2;
    } else {
      throw err;
    }
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
  return { status, stdout, stderr };
}

function tmpState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-')), 'state.json');
}

test('checksum error exits 11', () => {
  const s = tmpState();
  assert.equal(run(['init', s, '--bandwidth', '100', '--staging', '100']).status, 0);
  assert.equal(run(['request', s, '--id', 'O', '--size', '5', '--checksum', 'bad']).status, 0);
  const res = run(['restore', s]);
  assert.equal(res.status, 11);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.failures, [{ object: 'O', reason: 'checksum-error' }]);
});

test('disk full exits 11', () => {
  const s = tmpState();
  run(['init', s, '--bandwidth', '100', '--staging', '10']);
  run(['request', s, '--id', 'big', '--size', '20']);
  const res = run(['restore', s]);
  assert.equal(res.status, 11);
  assert.deepEqual(JSON.parse(res.stdout).failures, [{ object: 'big', reason: 'disk-full' }]);
});

test('cyclic dependency exits 11', () => {
  const s = tmpState();
  run(['init', s]);
  assert.equal(run(['request', s, '--id', 'A', '--size', '5', '--parent', 'B']).status, 0);
  const res = run(['request', s, '--id', 'B', '--size', '5', '--parent', 'A']);
  assert.equal(res.status, 11);
  assert.match(res.stderr, /cyclic-dependency/);
});

test('full workflow: request/restore/verify/correct/evict/undo', () => {
  const s = tmpState();
  run(['init', s, '--bandwidth', '1000', '--staging', '100']);
  run(['request', s, '--id', 'L', '--size', '60', '--retention', '1', '--requester', 'q']);
  let res = run(['restore', s]);
  assert.equal(res.status, 0);
  let out = JSON.parse(res.stdout);
  assert.ok(out.placement.some((p) => p.id === 'L'));
  assert.ok(out.timeSlices[0].allocations.length > 0);
  assert.ok(out.certificates.some((c) => c.action === 'restore' && c.object === 'L'));

  res = run(['verify', s]);
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).ok, true);

  // Preemption via CLI.
  run(['request', s, '--id', 'H', '--size', '50', '--retention', '5', '--requester', 'q']);
  res = run(['restore', s]);
  assert.equal(res.status, 0);
  out = JSON.parse(res.stdout);
  assert.equal(out.timeSlices[0].evicted[0].object, 'L');

  // Undo the preemption generation.
  res = run(['undo', s]);
  assert.equal(res.status, 0);
  res = run(['verify', s]);
  const report = JSON.parse(res.stdout);
  assert.equal(report.objects.L.status, 'verified');
  assert.equal(report.objects.H.status, 'pending');

  // Manual evict produces a proof.
  res = run(['evict', s, '--id', 'L']);
  assert.equal(res.status, 0);
  assert.ok(JSON.parse(res.stdout).proof);

  // Fault injection aborts and verify stays clean.
  run(['undo', s]);
  res = run(['restore', s, '--fail-at', 'cert']);
  assert.equal(res.status, 1);
  res = run(['verify', s]);
  assert.equal(res.status, 0);
});
