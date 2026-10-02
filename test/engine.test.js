import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, EngineError } from '../src/engine.js';

const PATTERNS = [
  { id: 'ab', parts: [{ lit: 'A' }, { lit: 'B' }] },
  { id: 'any-b', parts: [{ any: true }, { lit: 'B' }] },
  { id: 'rx', parts: [{ re: '^A' }, { re: 'B$' }] },
];

function run(engine, ops) {
  return ops.flatMap((op) => engine.apply(op));
}

test('overlapping patterns all reported in deterministic order', () => {
  const ops = [
    { setWindow: { n: 10 } },
    { upsert: { id: 'e1', ts: 1, sym: 'A' } },
    { upsert: { id: 'e2', ts: 2, sym: 'B' } },
  ];
  const first = run(new Engine(PATTERNS), ops);
  const second = run(new Engine(PATTERNS), ops);
  const emitted = first.filter((o) => o.op === 'emit');
  assert.equal(emitted.length, 3);
  assert.deepEqual(
    emitted.map((o) => o.cert.pattern),
    ['ab', 'any-b', 'rx'],
  );
  for (const output of emitted) {
    assert.deepEqual(output.cert.events, ['e1', 'e2']);
    assert.equal(output.cert.start, 'e1');
    assert.equal(output.cert.end, 'e2');
    assert.match(output.cert.fp, /^[0-9a-f]{16}$/);
    assert.match(output.windowHash, /^[0-9a-f]{16}$/);
  }
  assert.deepEqual(first, second);
});

test('same event participates in multiple matches and patterns', () => {
  const engine = new Engine([
    { id: 'aa', parts: [{ lit: 'A' }, { lit: 'A' }] },
    { id: 'aaa', parts: [{ lit: 'A' }, { lit: 'A' }, { lit: 'A' }] },
  ]);
  const out = run(engine, [
    { setWindow: { n: 5 } },
    { upsert: { id: 'x', ts: 1, sym: 'A' } },
    { upsert: { id: 'y', ts: 2, sym: 'A' } },
    { upsert: { id: 'z', ts: 3, sym: 'A' } },
  ]);
  const keys = out.filter((o) => o.op === 'emit').map((o) => `${o.cert.pattern}:${o.cert.events.join(',')}`);
  assert.deepEqual(keys, [
    'aa:x,y',
    'aa:x,z',
    'aa:y,z',
    'aaa:x,y,z',
  ]);
});

test('window sliding evicts old matches with retractAlarm only for what changed', () => {
  const engine = new Engine([{ id: 'ab', parts: [{ lit: 'A' }, { lit: 'B' }] }]);
  run(engine, [
    { setWindow: { n: 2 } },
    { upsert: { id: 'e1', ts: 1, sym: 'A' } },
    { upsert: { id: 'e2', ts: 2, sym: 'B' } },
  ]);
  assert.equal(engine.alarms.size, 1);
  const out = engine.apply({ upsert: { id: 'e3', ts: 3, sym: 'C' } });
  assert.deepEqual(out.map((o) => o.op), ['retractAlarm']);
  assert.deepEqual(out[0].cert.events, ['e1', 'e2']);
  assert.equal(engine.alarms.size, 0);
  const quiet = engine.apply({ upsert: { id: 'e4', ts: 4, sym: 'D' } });
  assert.deepEqual(quiet, []);
});

test('setWindow shrink and grow produce incremental corrections', () => {
  const engine = new Engine([{ id: 'ab', parts: [{ lit: 'A' }, { lit: 'B' }] }]);
  run(engine, [
    { upsert: { id: 'e1', ts: 1, sym: 'A' } },
    { upsert: { id: 'e2', ts: 2, sym: 'B' } },
  ]);
  assert.equal(engine.alarms.size, 1);
  const shrink = engine.apply({ setWindow: { n: 1 } });
  assert.deepEqual(shrink.map((o) => o.op), ['retractAlarm']);
  const grow = engine.apply({ setWindow: { n: 2 } });
  assert.deepEqual(grow.map((o) => o.op), ['emit']);
  assert.deepEqual(grow[0].cert.events, ['e1', 'e2']);
});

test('out-of-order upsert and override recompute alarms incrementally', () => {
  const engine = new Engine([{ id: 'ab', parts: [{ lit: 'A' }, { lit: 'B' }] }]);
  run(engine, [
    { setWindow: { n: 10 } },
    { upsert: { id: 'e2', ts: 2, sym: 'B' } },
  ]);
  const late = engine.apply({ upsert: { id: 'e1', ts: 1, sym: 'A' } });
  assert.deepEqual(late.map((o) => o.op), ['emit']);
  const correction = engine.apply({ upsert: { id: 'e1', ts: 1, sym: 'Z' } });
  assert.deepEqual(correction.map((o) => o.op), ['retractAlarm']);
  assert.equal(engine.alarms.size, 0);
});

test('retract removes matches; retract of unknown id fails with exit code 3', () => {
  const engine = new Engine([{ id: 'ab', parts: [{ lit: 'A' }, { lit: 'B' }] }]);
  run(engine, [
    { upsert: { id: 'e1', ts: 1, sym: 'A' } },
    { upsert: { id: 'e2', ts: 2, sym: 'B' } },
  ]);
  const out = engine.apply({ retract: { id: 'e1' } });
  assert.deepEqual(out.map((o) => o.op), ['retractAlarm']);
  assert.throws(() => engine.apply({ retract: { id: 'e1' } }), (error) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.exitCode, 3);
    return true;
  });
  assert.throws(() => engine.apply({ retract: { id: 'nope' } }), EngineError);
});

test('invalid ts and invalid window are rejected with exit code 3', () => {
  const engine = new Engine([{ id: 'p', parts: [{ any: true }] }]);
  for (const op of [
    { upsert: { id: 'e1', ts: 1.5, sym: 'A' } },
    { upsert: { id: 'e1', ts: '1', sym: 'A' } },
    { upsert: { id: 'e1', ts: null, sym: 'A' } },
    { setWindow: { n: 0 } },
    { setWindow: { n: -3 } },
    { setWindow: { n: 2.5 } },
    { setWindow: { n: '4' } },
  ]) {
    assert.throws(() => engine.apply(op), (error) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.exitCode, 3);
      return true;
    });
  }
});

test('windowHash after interleaved ops equals replay of final effective set', () => {
  const patterns = [
    { id: 'ab', parts: [{ lit: 'A' }, { lit: 'B' }] },
    { id: 'pair', parts: [{ any: true }, { re: 'B|C' }] },
  ];
  const engine = new Engine(patterns);
  run(engine, [
    { setWindow: { n: 3 } },
    { upsert: { id: 'e1', ts: 1, sym: 'A' } },
    { upsert: { id: 'e2', ts: 2, sym: 'B' } },
    { upsert: { id: 'e3', ts: 3, sym: 'C' } },
    { upsert: { id: 'e2', ts: 5, sym: 'B' } },
    { retract: { id: 'e1' } },
    { upsert: { id: 'e4', ts: 4, sym: 'A' } },
    { upsert: { id: 'e4', ts: 0, sym: 'A' } },
  ]);
  const finalEffective = [
    { id: 'e2', ts: 5, sym: 'B' },
    { id: 'e3', ts: 3, sym: 'C' },
    { id: 'e4', ts: 0, sym: 'A' },
  ];
  const replay = new Engine(patterns);
  replay.apply({ setWindow: { n: 3 } });
  const replayOut = finalEffective.flatMap((event) => replay.apply({ upsert: event }));
  const window = engine.windowEvents();
  const hash = engine.windowHash(window);
  const replayWindow = replay.windowEvents();
  assert.equal(hash, replay.windowHash(replayWindow));
  assert.deepEqual(
    [...engine.alarms.keys()].sort(),
    [...replay.alarms.keys()].sort(),
  );
  const lastHash = replayOut.length > 0 ? replayOut[replayOut.length - 1].windowHash : replay.windowHash(replayWindow);
  assert.equal(hash, lastHash);
});
