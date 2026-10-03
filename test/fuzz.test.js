import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VM } from '../src/vm.js';
import { genEvents } from './helpers/gen.js';
import { referencePrefixes } from './helpers/reference.js';

for (const seed of [1, 7, 42, 2024]) {
  test(`acceptance 4: random 200 events (seed ${seed}) match independent fold at every prefix`, () => {
    const events = genEvents(seed, 200);
    assert.equal(events.length, 200);
    const vm = new VM();
    const actual = [];
    for (const evt of events) {
      const r = vm.applyEvent(evt);
      assert.ok(r.ok, `event seq ${evt.seq} failed: ${JSON.stringify(r)} text=${evt.text}`);
      actual.push(vm.snapshot());
    }
    const expected = referencePrefixes(events);
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < actual.length; i++) {
      assert.deepStrictEqual(actual[i], expected[i], `prefix ${i} (seq ${events[i].seq}) text=${events[i].text}`);
    }
  });
}
