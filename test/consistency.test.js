import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRules } from '../src/engine.js';
import { VM } from '../src/vm.js';
import { naiveReplay } from '../src/reference.js';

// Deterministic PRNG (mulberry32).
const rng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const RULES = `
field temp: C;
field current: A;
group sensors = /^sensor-[0-9]+$/;
let hi = 80C;
rule hot on sensors {
  alert critical when temp > hi for 5m;
}
rule combo on all {
  alert warning when current > 10A for 1m and not temp > 95C;
}
rule spiky on all {
  alert info when temp < 60C or current >= 14A;
}
`;

const DEVICES = ['sensor-1', 'sensor-2', 'sensor-3', 'pump-1'];
const BASE = Date.UTC(2026, 0, 1);

// Generates a randomized event stream (<= maxEvents events) containing
// out-of-order arrivals, exact duplicates, corrections and retractions.
function generate(seed, maxEvents) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const events = [];       // normalized event objects, in stream order
  const liveIds = new Set();
  let counter = 0;

  // Per-device random-walk state so values cross thresholds for sustained
  // periods (otherwise 5m holds would almost never fire).
  const walk = new Map();
  const nextValue = (device, type) => {
    const key = `${device}:${type}`;
    const range = type === 'temp' ? [50, 110] : [4, 18];
    let v = walk.get(key) ?? (range[0] + range[1]) / 2;
    v += (rand() - 0.5) * (range[1] - range[0]) * 0.25;
    v = Math.min(range[1], Math.max(range[0], v));
    walk.set(key, v);
    return Math.round(v * 10) / 10;
  };

  const total = 50 + Math.floor(rand() * (maxEvents - 50));
  for (let i = 0; i < total; i++) {
    const r = rand();
    if (r < 0.12 && events.length > 0) {
      events.push(pick(events)); // exact duplicate: idempotent re-delivery
      continue;
    }
    if (r < 0.24 && liveIds.size > 0) {
      const target = pick([...liveIds]);
      liveIds.delete(target);
      if (rand() < 0.6) {
        const device = pick(DEVICES);
        const type = pick(['temp', 'current']);
        events.push({
          id: `c${counter++}`, time: BASE + Math.floor(rand() * 3600) * 1000,
          device, type, value: nextValue(device, type), replaces: target,
        });
      } else {
        events.push({ id: `x${counter++}`, retracts: target });
      }
      continue;
    }
    const device = pick(DEVICES);
    const type = pick(['temp', 'current']);
    const ev = {
      id: `e${counter++}`, time: BASE + Math.floor(rand() * 3600) * 1000,
      device, type, value: nextValue(device, type),
    };
    liveIds.add(ev.id);
    events.push(ev);
  }
  return events;
}

function runVM(program, events) {
  const vm = new VM(program);
  events.forEach((ev, i) => vm.ingest(ev, i + 1));
  vm.flush();
  return vm;
}

test('randomized streams (<=200 events, out-of-order, duplicates, corrections) match naive full replay', () => {
  const program = compileRules(RULES);
  for (let seed = 1; seed <= 40; seed++) {
    const events = generate(seed, 200);
    assert.ok(events.length <= 200);
    const vm = runVM(program, events);
    const expected = naiveReplay(program, events);
    assert.deepEqual(vm.effectiveAlerts(), expected, `seed ${seed}`);
  }
});

test('record log integrity: withdraws reference earlier alerts, ids unique', () => {
  const program = compileRules(RULES);
  for (let seed = 101; seed <= 110; seed++) {
    const vm = runVM(program, generate(seed, 200));
    const seen = new Set();
    for (const rec of vm.records) {
      if (rec.kind === 'alert') {
        assert.ok(!seen.has(rec.alert), `duplicate alert id ${rec.alert}`);
        seen.add(rec.alert);
      } else {
        assert.ok(seen.has(rec.alert), `withdraw of unknown alert ${rec.alert}`);
      }
    }
  }
});

test('same-timestamp events and device-changing corrections stay consistent', () => {
  const program = compileRules(RULES);
  const t = BASE;
  const events = [
    { id: 'e1', time: t, device: 'sensor-1', type: 'temp', value: 85 },
    { id: 'e2', time: t, device: 'sensor-1', type: 'current', value: 12 },
    { id: 'e3', time: t + 600_000, device: 'sensor-1', type: 'temp', value: 86 },
    // Correction moves e1 to another device entirely.
    { id: 'e4', time: t, device: 'sensor-2', type: 'temp', value: 90, replaces: 'e1' },
    { id: 'e5', time: t + 600_000, device: 'sensor-2', type: 'temp', value: 40 },
  ];
  const vm = runVM(program, events);
  assert.deepEqual(vm.effectiveAlerts(), naiveReplay(program, events));
});

test('empty stream and single event', () => {
  const program = compileRules(RULES);
  assert.deepEqual(runVM(program, []).effectiveAlerts(), []);
  const events = [{ id: 'e1', time: BASE, device: 'sensor-1', type: 'temp', value: 85 }];
  assert.deepEqual(runVM(program, events).effectiveAlerts(), naiveReplay(program, events));
});
