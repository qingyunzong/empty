import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { evaluateReference } from './helpers/reference.js';
import { mulberry32, generateSource, generateEvent } from './helpers/generator.js';

// Cross-check the bytecode VM against an independent decision-tree
// reference interpreter on randomly generated rules and events.
test('VM matches independent reference on random rules and events', () => {
  for (let seed = 0; seed < 200; seed++) {
    const rng = mulberry32(seed);
    const src = generateSource(rng);
    const engine = new Engine();
    engine.loadSource(src);
    for (let i = 0; i < 5; i++) {
      const event = generateEvent(rng, i);
      const vm = engine.evaluate(event);
      const ref = evaluateReference(src, event);
      const norm = (r) => ({
        decision: r.decision,
        version: r.version,
        strictest: r.strictest.map((h) => `${h.decision} ${h.path}/${h.rule}`),
        hits: r.hits.map((h) => `${h.decision} ${h.path}/${h.rule}`),
      });
      assert.deepEqual(
        norm(vm),
        norm(ref),
        `seed=${seed} event=${JSON.stringify(event)}\nrules:\n${src}`,
      );
    }
  }
});
