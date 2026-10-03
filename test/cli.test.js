import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReport } from '../src/report.js';

const EXAMPLE = new URL('../examples/preemption.json', import.meta.url).pathname;
const STARVATION = new URL('../examples/starvation.json', import.meta.url).pathname;

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('report contains timeline, violations, wakes, queue, certificates', () => {
  const out = buildReport(load(EXAMPLE), { verify: true });
  for (const key of ['timeline', 'violations', 'wakes', 'queue', 'certificates']) {
    assert.ok(Array.isArray(out[key]), `missing ${key}`);
  }
  assert.equal(out.ok, true);
  assert.deepEqual(out.certificateFailures, []);
  // the example exercises a successful preemption
  assert.ok(out.timeline.some((t) => t.type === 'preempted' && t.id === 'L1' && t.preemptedBy === 'H1'));
});

test('heap and naive strategies produce identical reports', () => {
  const input = load(EXAMPLE);
  assert.equal(
    JSON.stringify(buildReport(input, { strategy: 'naive', verify: true })),
    JSON.stringify(buildReport(input, { strategy: 'heap', verify: true })),
  );
});

test('reports are deterministic: identical inputs give identical bytes', () => {
  const input = load(STARVATION);
  assert.equal(
    JSON.stringify(buildReport(input, { verify: true })),
    JSON.stringify(buildReport(input, { verify: true })),
  );
});

test('every certificate in the report verifies and respects the pool cap', () => {
  const out = buildReport(load(EXAMPLE), { verify: true });
  for (const cert of out.certificates) {
    assert.ok(cert.pool.used <= cert.pool.cap);
    assert.match(cert.digest, /^[0-9a-f]{64}$/);
  }
});
