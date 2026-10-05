import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistories } from '../src/merge.js';
import { PendingError } from '../src/errors.js';
import { CONFIG, lines } from './helpers.js';

const TWO_DEVICE = [
  {
    name: 'A',
    text: lines(
      { id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 2 },
      { id: 'a2', device: 'A', ts: 2, op: 'sync', with: 'B', mark: 'm1' }
    ),
  },
  {
    name: 'B',
    text: lines(
      { id: 'b1', device: 'B', ts: 1, op: 'sync', with: 'A', mark: 'm1' },
      { id: 'b2', device: 'B', ts: 2, op: 'set_count', plot: 'P2', species: 'S1', tier: 1 }
    ),
  },
];

test('acceptance 3: exhausted budget yields PENDING, never a conflict verdict', () => {
  // first confirm the history itself is clean with a generous budget
  const ok = mergeHistories(CONFIG, TWO_DEVICE);
  assert.match(ok.verdict, /CONCURRENT_OK|LINEARIZABLE_MODEL/);

  for (const budget of [0, 1, 2, 3]) {
    let err = null;
    try {
      mergeHistories(CONFIG, TWO_DEVICE, { budget });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof PendingError, `budget ${budget}: expected PENDING, got ${err}`);
    // PENDING must not masquerade as a conflict: no cycle/conflict payload
    assert.equal(err.detail, undefined);
    assert.ok(!('cycle' in err));
  }
});

test('sufficient budget decides normally', () => {
  const result = mergeHistories(CONFIG, TWO_DEVICE, { budget: 10_000 });
  assert.equal(result.verdict, 'LINEARIZABLE_MODEL');
});
