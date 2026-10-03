import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from '../cli.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'credit-replica-'));
  return { dir, a: join(dir, 'a.json'), b: join(dir, 'b.json'), patch: join(dir, 'patch.json') };
}

// Runs the CLI in-process (the sandbox forbids spawning child processes) and
// captures the JSON lines it would print.
function run(args) {
  const lines = [];
  const code = execute(args, (value) => lines.push(value));
  assert.equal(lines.length, 1, 'exactly one JSON line per invocation');
  return { code, json: lines[0] };
}

test('cli: init, reserve, balance as JSON', () => {
  const { a } = setup();
  assert.deepEqual(run([a, 'init', '500']), {
    code: 0,
    json: { ok: true, limit: 500, reserved: 0, available: 500 },
  });
  const reserved = run([a, 'reserve', '{"requestId":"r1","account":"acct","amount":120}']);
  assert.deepEqual(reserved, {
    code: 0,
    json: { ok: true, changed: true, limit: 500, reserved: 120, available: 380 },
  });
  // Idempotent replay through the CLI.
  const replay = run([a, 'reserve', '{"requestId":"r1","account":"acct","amount":120}']);
  assert.equal(replay.code, 0);
  assert.equal(replay.json.changed, false);
  assert.deepEqual(run([a, 'balance']).json, { limit: 500, reserved: 120, available: 380 });
});

test('cli: errors are {"error":"code"} with exit code 1', () => {
  const { a } = setup();
  run([a, 'init', '100']);

  const overReserve = run([a, 'reserve', '{"requestId":"r1","account":"acct","amount":150}']);
  assert.equal(overReserve.code, 1);
  assert.deepEqual(overReserve.json, { error: 'limit-exceeded' });

  run([a, 'reserve', '{"requestId":"r2","account":"acct","amount":60}']);
  const overRelease = run([a, 'release', '{"requestId":"x1","reservationId":"r2","amount":61}']);
  assert.equal(overRelease.code, 1);
  assert.deepEqual(overRelease.json, { error: 'over-release' });

  const conflict = run([a, 'reserve', '{"requestId":"r2","account":"acct","amount":70}']);
  assert.equal(conflict.code, 1);
  assert.deepEqual(conflict.json, { error: 'conflict' });

  const unknown = run([a, 'release', '{"requestId":"x2","reservationId":"nope","amount":1}']);
  assert.equal(unknown.code, 1);
  assert.deepEqual(unknown.json, { error: 'unknown-reservation' });

  const badJson = run([a, 'reserve', '{oops']);
  assert.equal(badJson.code, 1);
  assert.deepEqual(badJson.json, { error: 'invalid-json' });
});

test('cli: diff/repair anti-entropy between two replica files', () => {
  const { a, b, patch } = setup();
  run([a, 'init', '500']);
  run([b, 'init', '500']);
  run([a, 'reserve', '{"requestId":"r-a","account":"acct-a","amount":100}']);
  run([a, 'release', '{"requestId":"rel-a","reservationId":"r-a","amount":40}']);
  run([b, 'reserve', '{"requestId":"r-b","account":"acct-b","amount":200}']);

  // B is missing A's reserve + release.
  const diffAB = run([a, 'diff', b]);
  assert.equal(diffAB.code, 0);
  assert.deepEqual(diffAB.json.missing.map((e) => e.requestId), ['r-a', 'rel-a']);
  writeFileSync(patch, JSON.stringify(diffAB.json));
  assert.equal(run([b, 'repair', patch]).code, 0);

  // A is missing B's reserve.
  const diffBA = run([b, 'diff', a]);
  assert.deepEqual(diffBA.json.missing.map((e) => e.requestId), ['r-b']);
  writeFileSync(patch, JSON.stringify(diffBA.json));
  assert.equal(run([a, 'repair', patch]).code, 0);

  // Both replicas converge: 60 (r-a) + 200 (r-b) reserved.
  const expected = { limit: 500, reserved: 260, available: 240 };
  assert.deepEqual(run([a, 'balance']).json, expected);
  assert.deepEqual(run([b, 'balance']).json, expected);
  assert.equal(run([a, 'summary']).json.digest, run([b, 'summary']).json.digest);

  // Converged: no more missing events in either direction.
  assert.deepEqual(run([a, 'diff', b]).json, { missing: [] });
  assert.deepEqual(run([b, 'diff', a]).json, { missing: [] });
});
