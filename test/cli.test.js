import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runSpec } from '../src/cli-core.js';

const root = path.dirname(fileURLToPath(new URL(import.meta.url)));

test('CLI reads JSON and reports per-op results', () => {
  const spec = JSON.parse(readFileSync(path.join(root, '..', 'examples', 'demo.json'), 'utf8'));
  const results = runSpec(spec);
  const byOp = (n) => results.filter((r) => r.op === n);

  assert.ok(byOp('addRule').every((r) => r.ok));
  const firstCheck = byOp('check')[0];
  assert.equal(firstCheck.checks.find((c) => c.id === 'low').status, 'conflict');
  const maybe = firstCheck.checks.find((c) => c.id === 'maybe');
  assert.equal(maybe.status, 'conflict');
  assert.ok(maybe.possible.length > 0);

  // after override, low is overridden; after undo, restored
  assert.equal(byOp('check')[1].checks.find((c) => c.id === 'low').status, 'overridden');
  assert.equal(byOp('check')[2].checks.find((c) => c.id === 'low').status, 'conflict');

  assert.deepEqual(byOp('enumerate')[0].instances.map((i) => i.start), ['1', '3', '3', '5']);
});

test('CLI surfaces transaction errors as failed ops without aborting', () => {
  const results = runSpec({
    horizon: 4,
    ops: [
      { op: 'addRule', id: 'ok', phase: 0, period: 2, duration: 1 },
      { op: 'addRule', id: 'bad', phase: 0, period: 0, duration: 1 },
      { op: 'addRule', id: 'bad2', phase: 0, period: '1/0', duration: 1 },
      { op: 'addReservation', id: 'z', start: 1, end: 1 },
      { op: 'state' },
    ],
  });
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /period must be > 0/);
  assert.equal(results[2].ok, false);
  assert.match(results[2].error, /denominator is zero/);
  assert.equal(results[3].ok, false);
  assert.match(results[3].error, /end must be > start/);
  assert.deepEqual(results[4].state.rules.map((r) => r.id), ['ok']);
});
