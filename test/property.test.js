import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze.js';
import { analyzeReference } from '../src/reference.js';
import { injectFaults, replayInjections } from '../src/inject.js';
import { randomEvents } from './helpers.js';

test('sweep-line matches reference enumeration of all legal intervals (<=14 events)', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const events = randomEvents(seed, 14);
    assert.ok(events.length <= 14);
    const main = analyze(events);
    const ref = analyzeReference(events);
    assert.deepEqual(main.timeline, ref.timeline, `timeline mismatch at seed ${seed}`);
    assert.deepEqual(main.oee, ref.oee, `oee mismatch at seed ${seed}`);
  }
});

test('normalized timeline tiles the window without overlap for random streams', () => {
  for (let seed = 1000; seed <= 1200; seed++) {
    const events = randomEvents(seed, 14);
    const { timeline } = analyze(events);
    for (let i = 1; i < timeline.length; i++) {
      assert.equal(timeline[i].start, timeline[i - 1].end, `gap/overlap at seed ${seed}`);
      assert.ok(timeline[i].durationMs > 0);
    }
  }
});

test('fault injection is replayable for random specs and seeds', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const events = randomEvents(seed, 14);
    const spec = {
      skew: { count: seed % 3, maxDeltaMs: 1000 + seed },
      lost: { count: seed % 2 },
      duplicate: { count: seed % 4 },
    };
    const { events: injected, log } = injectFaults(events, spec, seed);
    assert.deepEqual(replayInjections(events, log), injected, `replay mismatch at seed ${seed}`);
    const again = injectFaults(events, spec, seed);
    assert.deepEqual(again.events, injected, `non-deterministic injection at seed ${seed}`);
  }
});

test('duplicated fault events never change unplanned downtime', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const events = randomEvents(seed, 14);
    const fault = events.find((e) => e.type === 'fault');
    if (!fault) continue;
    const clean = analyze(events);
    const duped = analyze(events, {}, { injection: { spec: { duplicate: [{ id: fault.id, times: 2 }] } } });
    assert.equal(duped.oee.unplannedDowntimeMs, clean.oee.unplannedDowntimeMs, `seed ${seed}`);
    assert.equal(duped.oee.oee, clean.oee.oee, `seed ${seed}`);
  }
});
