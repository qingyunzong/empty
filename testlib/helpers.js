'use strict';
// Deterministic RNG + random small DAG event generator shared by tests.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES = ['pass', 'fail', 'pass', 'pass', 'weird', 'pending', ''];

function randomEvents(seed) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const events = [];
  const batches = [];
  const inspections = [];
  let counter = 0;
  const fresh = (prefix) => `${prefix}-${counter++}`;

  const intakeCount = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < intakeCount; i += 1) {
    const id = fresh('RM');
    events.push({ type: 'intake', batch: id, material: `mat-${i}` });
    batches.push(id);
  }

  const stepCount = 3 + Math.floor(rand() * 8);
  for (let i = 0; i < stepCount; i += 1) {
    if (rand() < 0.5) {
      const inputs = [];
      const n = 1 + Math.floor(rand() * Math.min(3, batches.length));
      const pool = [...batches];
      for (let j = 0; j < n; j += 1) {
        inputs.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
      }
      const output = fresh('B');
      events.push({ type: 'mix', output, inputs });
      batches.push(output);
    } else {
      const input = pick(batches);
      const outputs = [];
      const n = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < n; j += 1) outputs.push(fresh('P'));
      events.push({ type: 'split', input, outputs });
      batches.push(...outputs);
    }
  }

  for (const batch of batches) {
    if (rand() < 0.45) {
      const id = fresh('IN');
      events.push({ type: 'inspect', id, batch, test: 'micro', status: pick(STATUSES) });
      inspections.push(id);
    }
  }

  const scrapped = new Set();
  for (const batch of batches) {
    if (rand() < 0.15 && !scrapped.has(batch)) {
      scrapped.add(batch);
      events.push({ type: 'scrap', batch, reason: 'qa-hold' });
    }
  }

  for (const id of inspections) {
    if (rand() < 0.25) {
      events.push({ type: 'correct', inspection: id, status: pick(STATUSES), reason: 'retest' });
    }
  }

  return events;
}

module.exports = { mulberry32, randomEvents, STATUSES };
