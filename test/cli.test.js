import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'cli.js');

// NOTE: this sandbox swallows piped stdout of spawned node processes,
// so the CLI is run through `sh -c` with output redirected to files.
function run(args, { expectFail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'om-io-'));
  const outFile = join(dir, 'out');
  const codeFile = join(dir, 'code');
  const quoted = [CLI, ...args].map((a) => `'${String(a).replaceAll("'", "'\\''")}'`).join(' ');
  // The sandbox reports a spurious EPERM on res.error even when the
  // child actually ran, so success is determined by the exit-code file.
  spawnSync('sh', ['-c', `node ${quoted} > '${outFile}'; echo $? > '${codeFile}'`], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  const status = Number(readFileSync(codeFile, 'utf8').trim());
  const stdout = readFileSync(outFile, 'utf8');
  if (expectFail) {
    assert.equal(status, 1, `expected exit 1, got ${status}: ${stdout}`);
  } else {
    assert.equal(status, 0, `expected exit 0, got ${status}: ${stdout}`);
  }
  return JSON.parse(stdout);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'order-machine-'));
  return { a: join(dir, 'a.json'), b: join(dir, 'b.json') };
}

test('acceptance 1: cancel causally before match -> already-canceled', () => {
  const { a } = setup();
  run(['--db', a, '--replica', 'A', 'create', 'O1']);
  run(['--db', a, 'cancel', 'O1']);
  const out = run(['--db', a, 'match', 'O1'], { expectFail: true });
  assert.deepEqual(out, { error: 'already-canceled' });
  assert.equal(run(['--db', a, 'state', 'O1']).state, 'CANCELED');
});

test('acceptance 2: match causally before cancel -> already-matched', () => {
  const { a } = setup();
  run(['--db', a, '--replica', 'A', 'create', 'O2']);
  run(['--db', a, 'match', 'O2']);
  const out = run(['--db', a, 'cancel', 'O2'], { expectFail: true });
  assert.deepEqual(out, { error: 'already-matched' });
  assert.equal(run(['--db', a, 'state', 'O2']).state, 'MATCHED');
});

test('acceptance 3: concurrent cancel/match merge to conflict; cert invalid until resolved', () => {
  const { a, b } = setup();
  run(['--db', a, '--replica', 'A', 'create', 'O3']);
  run(['--db', b, '--replica', 'B', 'merge', a]); // B sees only the create
  run(['--db', a, 'cancel', 'O3']); // A cancels, unaware of B
  run(['--db', b, 'match', 'O3']); // B matches, unaware of A's cancel

  const merged = run(['--db', a, 'merge', b]);
  assert.equal(merged.orders.O3, 'CONFLICT');

  const state = run(['--db', a, 'state', 'O3']);
  assert.equal(state.state, 'CONFLICT');
  // both events are preserved, neither is dropped
  const types = state.events.map((e) => e.type).sort();
  assert.deepEqual(types, ['cancel', 'create', 'match']);

  const certBefore = run(['--db', a, 'cert', 'O3']);
  assert.equal(certBefore.valid, false);
  assert.equal(certBefore.certificate, null);

  // cannot cancel/match while in conflict
  assert.deepEqual(run(['--db', a, 'cancel', 'O3'], { expectFail: true }), { error: 'conflict' });

  run(['--db', a, 'resolve', 'O3', 'CANCELED', '--reason', 'ops review: cancel first seen', '--by', 'ops-alice']);
  assert.equal(run(['--db', a, 'state', 'O3']).state, 'CANCELED');

  const certAfter = run(['--db', a, 'cert', 'O3']);
  assert.equal(certAfter.valid, true);
  assert.equal(certAfter.state, 'CANCELED');
  assert.equal(certAfter.certificate.decision, 'CANCELED');
  assert.equal(certAfter.certificate.by, 'ops-alice');
  assert.equal(certAfter.certificate.reason, 'ops review: cancel first seen');
  assert.ok(certAfter.certificate.cancelEventId);
  assert.ok(certAfter.certificate.matchEventId);
});

test('resolve without conflict is rejected', () => {
  const { a } = setup();
  run(['--db', a, '--replica', 'A', 'create', 'O4']);
  assert.deepEqual(run(['--db', a, 'resolve', 'O4', 'CANCELED'], { expectFail: true }), {
    error: 'no-conflict',
  });
});

test('error envelope and exit code for unknown order / bad usage', () => {
  const { a } = setup();
  assert.deepEqual(run(['--db', a, 'state', 'nope'], { expectFail: true }), { error: 'not-found' });
  assert.deepEqual(run(['--db', a, 'cancel'], { expectFail: true }), { error: 'usage' });
  run(['--db', a, '--replica', 'A', 'create', 'O5']);
  assert.deepEqual(run(['--db', a, 'create', 'O5'], { expectFail: true }), { error: 'exists' });
});
