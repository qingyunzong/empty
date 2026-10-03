import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'auditlog-'));
}

// Runs the CLI in-process (the sandbox forbids nested spawns) with injected I/O.
function run(args, { input = '' } = {}) {
  let stdout = '';
  let stderr = '';
  const code = runCli(args, {
    readStdin: () => input,
    writeOut: (s) => (stdout += s),
    writeErr: (s) => (stderr += s),
  });
  return { code, stdout, stderr, json: stdout ? JSON.parse(stdout) : null };
}

const jsonl = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

test('append then verify: stats, root, violations', () => {
  const dir = tmpdir();
  const appended = run(['append', '--dir', dir], {
    input: jsonl([
      { tenant: 'a', data: 'first' },
      { tenant: 'b', data: 'second' },
      { tenant: 'a', data: 'third' },
    ]),
  });
  assert.equal(appended.code, 0);
  assert.equal(appended.json.stats.appended, 3);
  assert.equal(appended.json.stats.lastSeq, 3);
  assert.deepEqual(appended.json.stats.perTenant, { a: 2, b: 1 });
  assert.match(appended.json.root, /^[0-9a-f]{64}$/);
  assert.deepEqual(appended.json.violations, []);

  const verified = run(['verify', '--dir', dir]);
  assert.equal(verified.code, 0);
  assert.equal(verified.json.valid, true);
  assert.equal(verified.json.root, appended.json.root, 'verify root matches append root');
  assert.equal(verified.json.stats.events, 3);
});

test('tampered page is rejected by verify with CORRUPT', () => {
  const dir = tmpdir();
  run(['append', '--dir', dir], { input: jsonl([{ tenant: 'a', data: 'hello' }]) });
  const file = path.join(dir, 'events.log');
  const buf = fs.readFileSync(file);
  buf[100] ^= 0x01;
  fs.writeFileSync(file, buf);

  const result = run(['verify', '--dir', dir]);
  assert.equal(result.code, 3);
  assert.equal(result.json.valid, false);
  assert.equal(result.json.violations[0].code, 'CORRUPT');
});

test('recover truncates an uncommitted tail and writes quarantine proof', () => {
  const dir = tmpdir();
  const appended = run(['append', '--dir', dir], { input: jsonl([{ tenant: 'a', data: 'committed' }]) });
  fs.appendFileSync(path.join(dir, 'events.log'), Buffer.from('uncommitted-junk'));

  const recovered = run(['recover', '--dir', dir]);
  assert.equal(recovered.code, 0);
  assert.equal(recovered.json.stats.truncatedBytes, 16);
  assert.equal(recovered.json.stats.quarantinedBytes, 16);
  assert.equal(recovered.json.root, appended.json.root);
  assert.equal(recovered.json.quarantine.sha256.length, 64);

  const proofs = fs.readFileSync(path.join(dir, 'quarantine.jsonl'), 'utf8').trim().split('\n');
  assert.equal(proofs.length, 1);
  assert.deepEqual(JSON.parse(proofs[0]), recovered.json.quarantine);
  assert.equal(fs.statSync(path.join(dir, 'quarantine.bin')).size, 16);

  const verified = run(['verify', '--dir', dir]);
  assert.equal(verified.json.valid, true);
});

test('append to a read-only log fails with READONLY', () => {
  const dir = tmpdir();
  run(['append', '--dir', dir], { input: jsonl([{ tenant: 'a', data: 'x' }]) });
  fs.writeFileSync(path.join(dir, 'READONLY'), '');
  const result = run(['append', '--dir', dir], { input: jsonl([{ tenant: 'a', data: 'y' }]) });
  assert.equal(result.code, 5);
  assert.match(result.stderr, /READONLY/);
});

test('client-supplied seq gap is reported as SEQ_GAP', () => {
  const dir = tmpdir();
  const result = run(['append', '--dir', dir], {
    input: jsonl([
      { tenant: 'a', seq: 1, data: 'ok' },
      { tenant: 'a', seq: 9, data: 'gap' },
    ]),
  });
  assert.equal(result.code, 0);
  assert.equal(result.json.stats.appended, 1);
  assert.equal(result.json.violations.length, 1);
  assert.equal(result.json.violations[0].code, 'SEQ_GAP');
});

test('disk quota violations are reported and the hard cap holds', () => {
  const dir = tmpdir();
  const events = Array.from({ length: 10 }, (_, i) => ({ tenant: 't', data: `payload-${i}` }));
  const result = run(['append', '--dir', dir, '--disk', 't=100'], { input: jsonl(events) });
  assert.equal(result.code, 0);
  const quotaViolations = result.json.violations.filter((v) => v.code === 'QUOTA');
  assert.ok(quotaViolations.length > 0);
  assert.equal(quotaViolations.length + result.json.stats.appended, 10);
  // Hard cap: bytes stored for tenant t never exceed 100.
  const verified = run(['verify', '--dir', dir]);
  assert.equal(verified.json.valid, true);
  const raw = fs.readFileSync(path.join(dir, 'events.log'), 'utf8');
  let bytes = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('{')) bytes += Buffer.byteLength(line) + 1;
  }
  assert.ok(bytes <= 100, `tenant bytes ${bytes} exceed hard quota 100`);
});
