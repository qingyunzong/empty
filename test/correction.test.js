import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { sample } from './lineage.test.js';

test('acceptance 2: corrected parent edge — old slice unchanged, new slice updated', () => {
  const l = sample();
  l.append({ type: 'correct', child: 'C', from: 'A', to: 'D', ts: 6 });

  // old time slices keep the pre-correction genealogy
  assert.deepEqual(l.ancestors('C', 5).live.sort(), ['A', 'B']);
  assert.deepEqual(l.ancestors('E', 5).live.sort(), ['A', 'B', 'C', 'D']);

  // new slices reflect the compensation
  assert.deepEqual(l.ancestors('C', 6).live.sort(), ['B', 'D']);
  assert.deepEqual(l.ancestors('E', 6).live.sort(), ['B', 'C', 'D']);
  assert.deepEqual(l.descendants('A', 6).live, []); // A no longer feeds anything
  assert.deepEqual(l.descendants('A', 5).live.sort(), ['C', 'E']); // history intact

  // correction produced a new certificate version for C with updated parent hash
  const v0 = l.prove('C', 0).cert;
  const v1 = l.cert('C');
  assert.equal(v1.version, 1);
  assert.notEqual(v0.parentHash, v1.parentHash);
});

test('acceptance 2: pending correction is deferred, never unsatisfiable', () => {
  const l = sample();
  // target batch G does not exist yet: must not throw
  l.append({ type: 'correct', child: 'C', from: 'B', to: 'G', ts: 6 });
  assert.deepEqual(l.ancestors('C', 6).live.sort(), ['A', 'B']); // not applied yet
  assert.equal(l.stateAt().pending.length, 1);

  // once G arrives, the pending correction applies incrementally
  l.append({ type: 'add', id: 'G', parents: [], text: 'resin pellet bag', ts: 7 });
  assert.equal(l.stateAt().pending.length, 0);
  assert.deepEqual(l.ancestors('C', 7).live.sort(), ['A', 'G']);
  assert.deepEqual(l.ancestors('C', 6).live.sort(), ['A', 'B']); // slice before G unchanged
});
