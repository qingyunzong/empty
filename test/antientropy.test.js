import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEvents, ingestAll, canonicalState, mergeStates } from './helpers.js';
import { summarize, diffSummaries, repair } from '../src/antientropy.js';
import { emptyState, applyEvent } from '../src/state.js';

// Anti-entropy: interval summaries locate missing events; repair fills them.
test('repair via interval summaries converges to full merge', () => {
  const events = makeEvents(21, 40);
  const full = ingestAll(events);
  // Two terminals each saw only part of the stream (union covers everything).
  const a = ingestAll(events.filter((_, i) => i % 3 !== 0));
  const b = ingestAll(events.filter((_, i) => i % 3 !== 1));
  repair(a, b, { bucketMs: 5000 });
  repair(b, a, { bucketMs: 5000 });
  assert.equal(canonicalState(a), canonicalState(full));
  assert.equal(canonicalState(b), canonicalState(full));
  assert.equal(canonicalState(mergeStates(a, b)), canonicalState(full));
});

test('summaries detect a single missing event in its bucket', () => {
  const events = makeEvents(22, 20);
  const full = ingestAll(events);
  const partial = emptyState();
  for (const e of events) if (e.id !== 'e7') applyEvent(partial, e);
  const diff = diffSummaries(summarize(full, 10000), summarize(partial, 10000));
  assert.ok(diff.length >= 1, 'differing bucket detected');
  const missingTs = events.find((e) => e.id === 'e7').ts;
  assert.ok(diff.includes(Math.floor(missingTs / 10000)));
  const applied = repair(partial, full, { bucketMs: 10000 });
  assert.deepEqual(applied, ['e7']);
  assert.equal(canonicalState(partial), canonicalState(full));
});

test('repair is idempotent', () => {
  const events = makeEvents(23, 30);
  const a = ingestAll(events.slice(0, 15));
  const b = ingestAll(events);
  repair(a, b, { bucketMs: 5000 });
  const once = canonicalState(a);
  const appliedAgain = repair(a, b, { bucketMs: 5000 });
  assert.deepEqual(appliedAgain, []);
  assert.equal(canonicalState(a), once);
});
