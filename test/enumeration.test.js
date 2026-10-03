import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore, CRASH_POINTS } from '../src/store.js';

class SimulatedCrash extends Error {}

function tmpWal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-enum-'));
  return path.join(dir, 'events.wal');
}

function makeEvents(n) {
  const types = ['start', 'stop', 'alarm', 'count'];
  return Array.from({ length: n }, (_, i) => ({
    eventId: `ev-${i + 1}`,
    deviceId: `dev-${(i % 2) + 1}`,
    seq: Math.floor(i / 2) + 1,
    type: types[i % types.length],
  }));
}

// Naive reference: scan the frame log, keep the valid prefix, then keep only
// data frames that have a matching valid commit marker in that prefix.
function referenceVisible(frames) {
  const committed = new Set();
  for (const frame of frames) {
    if (frame.type === 'commit') committed.add(frame.seq);
  }
  return frames
    .filter((frame) => frame.type === 'data' && committed.has(frame.seq))
    .map((frame) => frame.event);
}

// Logical frame log produced by a scenario: appends 0..crashIndex-1 complete,
// append crashIndex dies at the given fault point (crashIndex === events.length
// means no crash).
function scenarioFrames(events, crashIndex, crashAt) {
  const frames = [];
  for (let i = 0; i < events.length; i += 1) {
    frames.push({ type: 'data', seq: i, event: events[i] });
    if (i === crashIndex && crashAt !== 'after_commit') return frames;
    frames.push({ type: 'commit', seq: i });
    if (i === crashIndex) return frames;
  }
  return frames;
}

// Runs the scenario against the real store: each append is a full
// write/fsync cycle; the crashed append throws at the fault point, the store
// is abandoned, and a fresh store recovers from disk.
function runScenario(events, crashIndex, crashAt) {
  const wal = tmpWal();
  let store = EventStore.open(wal);
  try {
    for (let i = 0; i < events.length; i += 1) {
      const opts = i === crashIndex
        ? { crashAt, onCrash: () => { throw new SimulatedCrash(); } }
        : {};
      store.append(events[i], opts);
    }
  } catch (err) {
    if (!(err instanceof SimulatedCrash)) throw err;
  } finally {
    store.close();
  }
  store = EventStore.open(wal);
  const visible = store.all();
  const perDevice = new Map();
  for (const event of visible) {
    const list = perDevice.get(event.deviceId) ?? [];
    list.push(event);
    perDevice.set(event.deviceId, list);
  }
  const queries = new Map();
  for (const [deviceId, list] of perDevice) {
    queries.set(deviceId, store.query(deviceId));
    for (const event of list) {
      queries.set(`${deviceId}@${event.seq}`, store.query(deviceId, event.seq));
    }
  }
  store.close();
  return { visible, queries };
}

test('acceptance 3: all fault prefixes for <=6 records match the reference', () => {
  let scenarios = 0;
  for (let n = 1; n <= 6; n += 1) {
    const events = makeEvents(n);
    // crashIndex === n means "no crash" (clean stop after n records).
    for (let crashIndex = 0; crashIndex <= n; crashIndex += 1) {
      const points = crashIndex === n ? [null] : CRASH_POINTS;
      for (const crashAt of points) {
        scenarios += 1;
        const expected = referenceVisible(scenarioFrames(events, crashIndex, crashAt));
        const { visible, queries } = runScenario(events, crashIndex, crashAt);
        assert.deepEqual(
          visible,
          expected,
          `n=${n} crashIndex=${crashIndex} crashAt=${crashAt}`,
        );
        // Secondary index must agree with the primary scan for every
        // deviceId+seq combination present in the expected prefix.
        for (const [deviceId, list] of queries) {
          if (deviceId.includes('@')) {
            const [dev, seq] = deviceId.split('@');
            assert.deepEqual(list, expected.filter((e) => e.deviceId === dev && e.seq === Number(seq)));
          } else {
            assert.deepEqual(list, expected.filter((e) => e.deviceId === deviceId));
          }
        }
      }
    }
  }
  assert.equal(scenarios, 69); // sum_{n=1..6} (1 + 3n)
});
