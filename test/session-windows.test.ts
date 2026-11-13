// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SessionWindowState,
  computeSessionWindows,
  connectedComponents,
} from '../index.js';

interface Event {
  id: string;
  timestamp: number;
  gapMs: number;
  key?: string;
}

const options = {
  getTimestamp: (event: Event) => event.timestamp,
  getGap: (event: Event) => event.gapMs,
  getKey: (event: Event) => event.key,
  getId: (event: Event) => event.id,
};

function signature(window) {
  return JSON.stringify({
    key: window.key,
    start: window.start,
    end: window.end,
    ids: [...window.eventIds].sort(),
  });
}

function componentSignature(events) {
  const start = Math.min(...events.map((event) => event.timestamp));
  const end = Math.max(
    ...events.map((event) => event.timestamp + event.gapMs),
  );
  return JSON.stringify({
    key: events[0].key ?? '',
    start,
    end,
    ids: events.map((event) => event.id).sort(),
  });
}

/**
 * Independent oracle: explicit pairwise interval-overlap graph plus union-find.
 * It deliberately does not use the library's sweep implementation.
 */
function oracleComponents(events) {
  const parent = events.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent[rootB] = rootA;
    }
  };

  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      const a = events[i];
      const b = events[j];
      if ((a.key ?? '') !== (b.key ?? '')) {
        continue;
      }
      const aEnd = a.timestamp + a.gapMs;
      const bEnd = b.timestamp + b.gapMs;
      if (a.timestamp <= bEnd && b.timestamp <= aEnd) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < events.length; i += 1) {
    const root = find(i);
    const group = groups.get(root);
    if (group) {
      group.push(events[i]);
    } else {
      groups.set(root, [events[i]]);
    }
  }
  return [...groups.values()]
    .map(componentSignature)
    .sort();
}

function permutations(items) {
  if (items.length <= 1) {
    return [items.slice()];
  }
  const result = [];
  for (let index = 0; index < items.length; index += 1) {
    const head = items[index];
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) {
      result.push([head, ...tail]);
    }
  }
  return result;
}

test('gap is an event interval and components are interval-connected', () => {
  const events = [
    { id: 'a', timestamp: 0, gapMs: 5 },
    { id: 'b', timestamp: 12, gapMs: 5 },
    { id: 'c', timestamp: 5, gapMs: 7 },
    { id: 'd', timestamp: 20, gapMs: 0 },
    { id: 'e', timestamp: 20, gapMs: 3 },
  ];

  const components = connectedComponents(events, options);
  assert.deepEqual(
    components.map((component) => component.map((event) => event.id)),
    [['a', 'c', 'b'], ['d', 'e']],
  );

  const windows = computeSessionWindows(events, options);
  assert.deepEqual(windows.map(signature), [
    JSON.stringify({ key: '', start: 0, end: 17, ids: ['a', 'b', 'c'] }),
    JSON.stringify({ key: '', start: 20, end: 23, ids: ['d', 'e'] }),
  ]);
});

test('a bridge retracts every old version and emits one merged version', () => {
  const state = new SessionWindowState(options);

  const first = state.add({ id: 'a', timestamp: 0, gapMs: 5 });
  const second = state.add({ id: 'b', timestamp: 12, gapMs: 5 });
  assert.equal(first.emitted.length, 1);
  assert.equal(second.emitted.length, 1);
  assert.equal(state.getOpenWindows().length, 2);

  const bridged = state.add({ id: 'c', timestamp: 5, gapMs: 7 });
  assert.equal(bridged.accepted, true);
  assert.deepEqual(
    bridged.retracted.map((window) => window.id).sort(),
    [first.emitted[0].id, second.emitted[0].id].sort(),
  );
  assert.equal(bridged.emitted.length, 1);
  assert.equal(bridged.emissions.length, 1);
  assert.equal(bridged.emitted[0].start, 0);
  assert.equal(bridged.emitted[0].end, 17);
  assert.deepEqual(bridged.emitted[0].eventIds, ['a', 'c', 'b']);
  assert.equal(bridged.emitted[0].version, 2);
  assert.equal(state.getOpenWindows().length, 1);
});

test('dynamic gaps are evaluated per event, including out of order', () => {
  const state = new SessionWindowState(options);
  state.add({ id: 'a', timestamp: 0, gapMs: 2 });
  state.add({ id: 'b', timestamp: 5, gapMs: 2 });
  assert.equal(state.getOpenWindows().length, 2);

  // c's own forward gap reaches b, but it cannot reach back to a.
  state.add({ id: 'c', timestamp: 3, gapMs: 5 });
  assert.deepEqual(
    state.getOpenWindows().map(signature),
    [
      JSON.stringify({ key: '', start: 0, end: 2, ids: ['a'] }),
      JSON.stringify({ key: '', start: 3, end: 8, ids: ['b', 'c'] }),
    ],
  );

  // x touches a's end and c's start, so all four events become one component.
  state.add({ id: 'x', timestamp: 2, gapMs: 1 });
  assert.equal(state.getOpenWindows().length, 1);
  assert.deepEqual(state.getOpenWindows()[0].eventIds, ['a', 'x', 'c', 'b']);
  assert.equal(state.getOpenWindows()[0].end, 8);
});

test('watermark closure is final and late events cannot rewrite it', () => {
  const state = new SessionWindowState(options);
  state.add({ id: 'a', timestamp: 0, gapMs: 10 });
  state.add({ id: 'b', timestamp: 5, gapMs: 2 });
  assert.equal(state.getOpenWindows()[0].end, 10);

  const closed = state.advanceWatermark(10);
  assert.equal(closed.closed.length, 1);
  assert.equal(closed.closed[0].status, 'closed');
  assert.equal(closed.closed[0].closedAtWatermark, 10);
  assert.equal(state.getOpenWindows().length, 0);

  const frozen = JSON.stringify(state.getClosedWindows()[0]);
  const late = state.add({ id: 'late', timestamp: 9, gapMs: 100 });
  assert.equal(late.accepted, false);
  assert.equal(late.reason, 'late');
  assert.equal(late.retracted.length, 0);
  assert.equal(late.emitted.length, 0);
  assert.equal(JSON.stringify(state.getClosedWindows()[0]), frozen);

  const later = state.add({ id: 'later', timestamp: 11, gapMs: 100 });
  assert.equal(later.accepted, true);
  assert.equal(state.getOpenWindows().length, 1);
  assert.equal(state.getOpenWindows()[0].start, 11);
  assert.equal(JSON.stringify(state.getClosedWindows()[0]), frozen);

  assert.equal(
    state.advanceWatermark(Number.POSITIVE_INFINITY).closed.length,
    1,
  );
  assert.throws(() => state.advanceWatermark(50), RangeError);
});

test('keys are isolated and duplicate ids do not change state', () => {
  const state = new SessionWindowState(options);
  assert.equal(
    state.add({ id: 'a', timestamp: 0, gapMs: 5, key: 'left' }).emitted.length,
    1,
  );
  assert.equal(
    state.add({ id: 'a', timestamp: 0, gapMs: 5, key: 'right' }).emitted.length,
    1,
  );
  assert.equal(state.getOpenWindows().length, 2);

  const before = JSON.stringify(state.snapshot());
  const duplicate = state.add({ id: 'a', timestamp: 0, gapMs: 5, key: 'left' });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'duplicate');
  const conflict = state.add({ id: 'a', timestamp: 1, gapMs: 5, key: 'left' });
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.reason, 'duplicate-id');
  assert.equal(JSON.stringify(state.snapshot()), before);
});

test('partial closure cannot resurrect closed events', () => {
  const state = new SessionWindowState(options);
  const old = state.add({ id: 'old', timestamp: 0, gapMs: 10 });
  const open = state.add({ id: 'open', timestamp: 20, gapMs: 10 });
  assert.equal(state.getOpenWindows().length, 2);

  const watermark = state.advanceWatermark(10);
  assert.deepEqual(
    watermark.closed.map((window) => window.id),
    [old.emitted[0].id],
  );
  const closedSnapshot = JSON.stringify(state.getClosedWindows());

  const merged = state.add({ id: 'middle', timestamp: 11, gapMs: 9 });
  assert.deepEqual(
    merged.retracted.map((window) => window.id),
    [open.emitted[0].id],
  );
  assert.equal(merged.emitted.length, 1);
  assert.deepEqual(merged.emitted[0].eventIds, ['middle', 'open']);
  assert.equal(merged.emitted[0].start, 11);
  assert.equal(merged.emitted[0].end, 30);
  assert.equal(JSON.stringify(state.getClosedWindows()), closedSnapshot);
  assert.equal(state.getOpenWindows().length, 1);
});

test('exhaustive permutations agree with an independent component oracle', () => {
  const eventSets = [
    [
      { id: 'a', timestamp: 0, gapMs: 5 },
      { id: 'b', timestamp: 12, gapMs: 5 },
      { id: 'c', timestamp: 5, gapMs: 7 },
      { id: 'd', timestamp: 20, gapMs: 4 },
      { id: 'e', timestamp: 24, gapMs: 2 },
    ],
    [
      { id: 'a', timestamp: 0, gapMs: 3, key: 'left' },
      { id: 'b', timestamp: 2, gapMs: 3, key: 'right' },
      { id: 'c', timestamp: 5, gapMs: 6, key: 'left' },
      { id: 'd', timestamp: 8, gapMs: 0, key: 'right' },
    ],
  ];

  for (const events of eventSets) {
    const expected = oracleComponents(events);
    for (const permutation of permutations(events)) {
      const state = new SessionWindowState(options);
      const published = new Map();

      for (const event of permutation) {
        const result = state.add(event);
        assert.equal(result.accepted, true);

        for (const oldVersion of result.retracted) {
          const key = `${oldVersion.id}@${oldVersion.version}`;
          assert.ok(
            published.has(key),
            `retracted version ${key} must have been published`,
          );
          published.delete(key);
        }

        for (const version of result.emitted) {
          const key = `${version.id}@${version.version}`;
          assert.equal(version.status, 'triggered');
          assert.equal(version.closed, false);
          assert.ok(!published.has(key), `duplicate publication ${key}`);
          published.set(key, version);
        }
      }

      const stateSignatures = state.getOpenWindows().map(signature).sort();
      const publishedSignatures = [...published.values()]
        .map(signature)
        .sort();
      assert.deepEqual(publishedSignatures, stateSignatures);
      assert.deepEqual(stateSignatures, expected);

      const allEventIds = state
        .getOpenWindows()
        .flatMap((window) => window.eventIds)
        .sort();
      assert.deepEqual(
        allEventIds,
        events.map((event) => event.id).sort(),
      );
    }
  }
});
