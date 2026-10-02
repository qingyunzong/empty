import assert from 'node:assert/strict';
import { EventStore } from '../src/store.js';

/**
 * Shared core for the permutation property test: enumerate operation orders
 * and check the store against a naive reference model — a plain version
 * array, "sorted by txAt + snapshot filter".
 */

export function publicOf(v) {
  return { eventId: v.eventId, deviceId: v.deviceId, validAt: v.validAt, txAt: v.txAt, data: v.data };
}

const OP_TOKEN = { create: 'c', correct: 'o', delete: 'd' };

export class RefStore {
  constructor() {
    this.versions = []; // appended in commit order => sorted by txAt
    this.clock = 0;
    this.live = new Map(); // incremental head cache, equivalent to liveAt(this.clock)
    this.key = ''; // canonical committed-op sequence key
  }

  liveAt(snapTs) {
    const map = new Map();
    for (const v of this.versions) {
      if (v.txAt > snapTs) break;
      if (v.deleted) map.delete(v.eventId);
      else map.set(v.eventId, v);
    }
    return map;
  }

  visibleAt(snapTs, eventId) {
    let found = null;
    for (const v of this.versions) {
      if (v.txAt > snapTs) break;
      if (v.eventId === eventId) found = v;
    }
    return found && !found.deleted ? found : null;
  }

  /** Returns null on success, or the error code the store must also produce. */
  apply(op) {
    const head = this.live.get(op.eventId) ?? null;
    if (op.type === 'create') {
      if (head) return 'E_DUP';
      this.clock += 1;
      const v = { eventId: op.eventId, deviceId: op.deviceId, validAt: op.validAt, data: op.data, deleted: false, txAt: this.clock };
      this.versions.push(v);
      this.live.set(op.eventId, v);
    } else {
      if (!head) return 'E_NOTFOUND';
      this.clock += 1;
      if (op.type === 'correct') {
        const v = { eventId: head.eventId, deviceId: head.deviceId, validAt: op.validAt, data: op.data, deleted: false, txAt: this.clock };
        this.versions.push(v);
        this.live.set(op.eventId, v);
      } else {
        const v = { ...head, data: null, deleted: true, txAt: this.clock };
        this.versions.push(v);
        this.live.delete(op.eventId);
      }
    }
    this.key += OP_TOKEN[op.type] + op.eventId + ';';
    return null;
  }

  rangeAt(snapTs, deviceId, from, to) {
    if (from > to) return [];
    const out = [];
    for (const v of this.liveAt(snapTs).values()) {
      if (v.deviceId === deviceId && v.validAt >= from && v.validAt <= to) out.push(publicOf(v));
    }
    out.sort((a, b) => a.validAt - b.validAt || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
    return out;
  }
}

function applyToStore(store, op) {
  try {
    if (op.type === 'create') store.create(op);
    else if (op.type === 'correct') store.correct(op);
    else store.delete(op.eventId);
    return null;
  } catch (err) {
    return err.code;
  }
}

export function opsFor(eventCount) {
  const ops = [];
  for (let i = 0; i < eventCount; i += 1) {
    const eventId = `ev${i}`;
    const deviceId = `dev${i % 2}`;
    ops.push({ type: 'create', eventId, deviceId, validAt: 10 + i * 10, data: { n: i, kind: 'created' } });
    ops.push({ type: 'correct', eventId, validAt: 1000 + i * 10, data: { n: i, kind: 'corrected' } });
    ops.push({ type: 'delete', eventId });
  }
  return ops;
}

export function* permutations(items) {
  const a = items.slice();
  yield a;
  const c = new Array(a.length).fill(0);
  let i = 0;
  while (i < a.length) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
      yield a;
      c[i] += 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
}

const DEVICES = ['dev0', 'dev1'];

function verifySnapshot(snap, ref, ts, eventIds, ops) {
  const actual = {
    ranges: DEVICES.map((d) => snap.range(d, -Infinity, Infinity)),
    gets: eventIds.map((id) => snap.get(id)),
  };
  const expected = {
    ranges: DEVICES.map((d) => ref.rangeAt(ts, d, -Infinity, Infinity)),
    gets: eventIds.map((id) => {
      const v = ref.visibleAt(ts, id);
      return v ? publicOf(v) : null;
    }),
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    assert.deepEqual(actual, expected, `snapshot@${ts} mismatch after ${JSON.stringify(ops)}`);
  }
}

export function checkSequence(ops, verifiedStates) {
  const store = new EventStore();
  const ref = new RefStore();
  const eventIds = [...new Set(ops.map((op) => op.eventId))];
  const pending = []; // [snapshot, stateKey, ts]
  const record = () => {
    if (verifiedStates.has(ref.key)) return;
    const snap = store.snapshot();
    pending.push([snap, ref.key, snap.ts]);
  };
  record();
  for (const op of ops) {
    const storeErr = applyToStore(store, op);
    const refErr = ref.apply(op);
    if (storeErr !== refErr) {
      assert.fail(`error mismatch for op ${JSON.stringify(op)} in ${JSON.stringify(ops)}: store=${storeErr} ref=${refErr}`);
    }
    record();
  }
  for (const [snap, key, ts] of pending) {
    verifySnapshot(snap, ref, ts, eventIds, ops);
    verifiedStates.add(key);
  }
}

/** Check the permutations with index % numWorkers === workerId. Returns count checked. */
export function checkSlice(eventCount, workerId, numWorkers) {
  const verifiedStates = new Set();
  let index = 0;
  let checked = 0;
  for (const perm of permutations(opsFor(eventCount))) {
    if (index % numWorkers === workerId) {
      checkSequence(perm, verifiedStates);
      checked += 1;
    }
    index += 1;
  }
  return checked;
}
