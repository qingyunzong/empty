import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compress,
  decompress,
  serializeStream,
  summarize,
  type CompressedRecord,
  type MergedGroup,
  type StreamEvent,
} from '../src/event-compressor.js';

function put(id: string, key: string, version: number, data: string): StreamEvent {
  return { kind: 'put', id, key, version, data: Buffer.from(data, 'utf8') };
}

function barrier(id: string): StreamEvent {
  return { kind: 'barrier', id };
}

function groups(records: CompressedRecord[]): MergedGroup[] {
  return records.filter((r): r is MergedGroup => r.kind === 'group');
}

/** Deterministic PRNG (mulberry32) so random tests are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('merges consecutive versions of the same key into one group', () => {
  const events = [
    put('e1', 'alpha', 1, 'aa'),
    put('e2', 'alpha', 2, 'bb'),
    put('e3', 'alpha', 3, 'cc'),
  ];
  const records = compress(events);
  assert.equal(records.length, 1);
  const [group] = groups(records);
  assert.equal(group.key, 'alpha');
  assert.equal(group.startVersion, 1);
  assert.equal(group.endVersion, 3);
  assert.equal(group.initialValue.toString(), 'aa');
  assert.equal(group.finalValue.toString(), 'cc');
  assert.deepEqual(group.mergedIds, ['e1', 'e2', 'e3']);
});

test('explicit barrier forbids merging across it', () => {
  const events = [
    put('e1', 'alpha', 1, 'aa'),
    barrier('B1'),
    put('e2', 'alpha', 2, 'bb'),
  ];
  const records = compress(events);
  assert.equal(records.length, 3);
  assert.equal(records[0].kind, 'group');
  assert.deepEqual(records[1], { kind: 'barrier', id: 'B1' });
  assert.equal(records[2].kind, 'group');
  const [left, right] = groups(records);
  assert.deepEqual(left.mergedIds, ['e1']);
  assert.deepEqual(right.mergedIds, ['e2']);
});

test('key change or non-consecutive version starts a new group', () => {
  const events = [
    put('e1', 'alpha', 1, 'a1'),
    put('e2', 'beta', 1, 'b1'),
    put('e3', 'alpha', 2, 'a2'),
    put('e4', 'alpha', 5, 'a5'),
  ];
  const merged = groups(compress(events));
  assert.equal(merged.length, 4);
  assert.deepEqual(merged.map((g) => g.mergedIds), [['e1'], ['e2'], ['e3'], ['e4']]);
});

test('summary reports initial value, final value and merged ids', () => {
  const events = [
    put('e1', 'alpha', 1, 'aa'),
    put('e2', 'alpha', 2, 'zz'),
    barrier('B1'),
  ];
  const lines = summarize(compress(events));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /key=alpha/);
  assert.match(lines[0], /versions=1\.\.2/);
  assert.match(lines[0], /initial=6161/);
  assert.match(lines[0], /final=7a7a/);
  assert.match(lines[0], /mergedIds=\[e1,e2\]/);
  assert.equal(lines[1], 'barrier id=B1');
});

test('decompress restores the original event order and bytes', () => {
  const events = [
    put('e1', 'alpha', 1, 'aa'),
    put('e2', 'alpha', 2, 'bb'),
    barrier('B1'),
    put('e3', 'beta', 1, 'cc'),
    put('e4', 'alpha', 3, 'dd'),
  ];
  const restored = decompress(compress(events));
  assert.deepEqual(restored, events);
  assert.ok(serializeStream(restored).equals(serializeStream(events)));
});

test('empty stream compresses to nothing', () => {
  assert.deepEqual(compress([]), []);
  assert.deepEqual(decompress([]), []);
});

test('random barriers interleaved with same keys: round-trip byte sequence is identical', () => {
  const ITERATIONS = 500;
  const KEYS = ['alpha', 'beta', 'gamma'];

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const rand = mulberry32(iter * 2654435761 + 1);
    const length = Math.floor(rand() * 60);
    const versions = new Map<string, number>(KEYS.map((k) => [k, 0]));
    const events: StreamEvent[] = [];

    for (let i = 0; i < length; i++) {
      if (rand() < 0.25) {
        events.push(barrier(`B${iter}:${i}`));
        continue;
      }
      const key = KEYS[Math.floor(rand() * KEYS.length)];
      // Mostly advance the version; occasionally skip ahead so the
      // compressor must split the group even for the same key.
      const next = versions.get(key)! + (rand() < 0.85 ? 1 : 2);
      versions.set(key, next);
      const size = Math.floor(rand() * 17);
      const data = Buffer.alloc(size);
      for (let b = 0; b < size; b++) data[b] = Math.floor(rand() * 256);
      events.push({ kind: 'put', id: `e${iter}:${i}`, key, version: next, data });
    }

    const records = compress(events);
    const restored = decompress(records);

    assert.deepEqual(
      restored,
      events,
      `iter ${iter}: restored events differ from the original stream`,
    );
    assert.ok(
      serializeStream(restored).equals(serializeStream(events)),
      `iter ${iter}: byte sequence mismatch after round-trip`,
    );

    // No group may span a barrier: merged ids must occupy a contiguous,
    // barrier-free window of the original stream.
    const indexById = new Map(events.map((e, i) => [e.id, i]));
    for (const group of groups(records)) {
      const positions = group.mergedIds.map((id) => indexById.get(id)!);
      for (let p = 1; p < positions.length; p++) {
        assert.equal(positions[p], positions[p - 1] + 1, `iter ${iter}: group not contiguous`);
      }
      for (let p = positions[0]; p <= positions[positions.length - 1]; p++) {
        assert.notEqual(events[p].kind, 'barrier', `iter ${iter}: group spans a barrier`);
      }
      for (let f = 1; f < group.frames.length; f++) {
        assert.equal(
          group.frames[f].version,
          group.frames[f - 1].version + 1,
          `iter ${iter}: versions not consecutive inside group`,
        );
      }
      assert.equal(group.initialValue.toString('hex'), group.frames[0].data.toString('hex'));
      assert.equal(
        group.finalValue.toString('hex'),
        group.frames[group.frames.length - 1].data.toString('hex'),
      );
    }
  }
});
