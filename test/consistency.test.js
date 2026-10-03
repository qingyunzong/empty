// Acceptance 3: out-of-order, duplicated, corrected and retracted random
// streams of up to 200 events must agree with the naive full-replay reference.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/index.js';
import { Engine } from '../src/engine.js';
import { fullReplay, foldActive } from '../src/replay.js';

const RULES = `
let t_hi = 80C
let c_hi = 10A
alert hot level critical on devices(/^dev-/) when temp > t_hi for 5m
alert curr level warning on devices(dev-a, dev-b) when current > c_hi for 2m
alert combo level info on devices(/^dev-/) when temp > 85C and current > 5A or not temp > 50C
`;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(seed, count) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const devices = ['dev-a', 'dev-b', 'dev-c', 'dev-d', 'other-x'];
  const records = [];
  let nextId = 0;
  for (let i = 0; i < count; i++) {
    const roll = rnd();
    if (roll < 0.08 && records.length > 0) {
      // duplicate delivery of an earlier record (idempotency)
      records.push(records[Math.floor(rnd() * records.length)]);
    } else if (roll < 0.2 && nextId > 0) {
      // correction of a random earlier event id
      const target = `e${Math.floor(rnd() * nextId)}`;
      records.push({
        id: `e${nextId++}`,
        time: Math.floor(rnd() * 3600000),
        device: pick(devices),
        type: 'temp',
        value: 40 + rnd() * 70,
        replaces: target,
      });
    } else if (roll < 0.28 && nextId > 0) {
      // retraction of a random earlier event id
      records.push({ id: `r${nextId}`, retracts: `e${Math.floor(rnd() * nextId)}` });
    } else {
      const type = rnd() < 0.6 ? 'temp' : 'current';
      records.push({
        id: `e${nextId++}`,
        time: Math.floor(rnd() * 3600000),
        device: pick(devices),
        type,
        value: type === 'temp' ? 40 + rnd() * 70 : rnd() * 16,
      });
    }
  }
  return records;
}

for (const seed of [1, 2, 3, 7, 42, 99, 1234, 2026]) {
  test(`random stream (seed ${seed}, <=200 events) matches naive full replay`, () => {
    const rules = compile(RULES);
    const records = generate(seed, 200);
    assert.ok(records.length <= 200);

    const engine = new Engine(rules);
    engine.processAll(records);
    const replay = fullReplay(records, rules);

    // same domain errors, same final active alert set
    assert.deepEqual(engine.errors, replay.errors);
    assert.deepEqual(foldActive(engine.records), foldActive(replay.records));
    assert.deepEqual(engine.activeAlerts(), foldActive(replay.records));

    // determinism: identical re-run, byte-identical records
    const again = new Engine(rules);
    again.processAll(records);
    assert.deepEqual(again.records, engine.records);
  });
}

test('in-order stream without corrections yields exactly the replay records', () => {
  const rules = compile('alert hot level critical on devices(/^dev-/) when temp > 80C for 5m');
  const records = [
    { id: 'e1', time: 0, device: 'dev-1', type: 'temp', value: 85 },
    { id: 'e2', time: 60000, device: 'dev-1', type: 'temp', value: 86 },
    { id: 'e3', time: 600000, device: 'dev-1', type: 'temp', value: 70 },
    { id: 'e4', time: 700000, device: 'dev-2', type: 'temp', value: 90 },
  ];
  const engine = new Engine(rules);
  engine.processAll(records);
  const replay = fullReplay(records, rules);
  const strip = (rs) => rs.map(({ seq, ...rest }) => rest);
  assert.deepEqual(strip(engine.records), strip(replay.records));
});
