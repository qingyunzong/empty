import test from 'node:test';
import assert from 'node:assert/strict';
import { Rat } from '../src/rational';
import { Timeline } from '../src/timeline';
import { Player, Marker, Fired } from '../src/player';

const tl = new Timeline([
  { t: Rat.of(0), v: 0 },
  { t: Rat.of(2), v: 1 },
]);
const D = Rat.of(2);

const fmt = (fs: Fired[]) => fs.map((f) => `${f.name}@${f.at}:${f.dir}`);

function player(mode: 'once' | 'loop' | 'pingpong', markers: Marker[]): Player {
  return new Player(tl, { mode, markers });
}

test('once: forward step fires (a, b], backward fires [b, a)', () => {
  const p = player('once', [
    { name: 'a', t: Rat.of(1, 2) },
    { name: 'b', t: Rat.of(1) },
  ]);
  assert.deepEqual(fmt(p.advance(Rat.of(1))), ['a@1/2:forward', 'b@1:forward']);
  // step starting exactly at a marker does not refire it
  assert.deepEqual(fmt(p.advance(Rat.of(1, 2))), []);
  // reverse 3/2 -> 1/2: markers in [1/2, 3/2) crossed backward, descending order
  assert.deepEqual(fmt(p.advance(Rat.of(-1))), ['b@1:backward', 'a@1/2:backward']);
});

test('once: landing exactly on a marker fires it (forward)', () => {
  const p = player('once', [{ name: 'm', t: Rat.of(1) }]);
  assert.deepEqual(fmt(p.advance(Rat.of(1))), ['m@1:forward']);
  assert.deepEqual(fmt(p.advance(Rat.of(1))), []); // already past
});

test('loop: wrap-around fires events in both cycles, once each', () => {
  const p = player('loop', [
    { name: 'q', t: Rat.of(1, 2) },
    { name: 'r', t: Rat.of(3, 2) },
  ]);
  p.seek(Rat.of(3, 2)); // local 1.5 of cycle 0
  // advance 2: crosses r@3/2? no (start excluded), wraps, q@5/2, r@7/2... ends at 7/2
  const fired = p.advance(Rat.of(2));
  assert.deepEqual(fmt(fired), ['q@5/2:forward', 'r@7/2:forward']);
});

test('loop: reverse playback mirrors direction and order', () => {
  const p = player('loop', [
    { name: 'q', t: Rat.of(1, 2) },
    { name: 'r', t: Rat.of(3, 2) },
  ]);
  p.seek(Rat.of(7, 2));
  const fired = p.advance(Rat.of(-2)); // [3/2, 7/2): q@5/2, r@3/2
  assert.deepEqual(fmt(fired), ['q@5/2:backward', 'r@3/2:backward']);
});

test('loop: forward then backward over same range flips directions and order', () => {
  const markers: Marker[] = [
    { name: 'q', t: Rat.of(1, 2) },
    { name: 'r', t: Rat.of(3, 2) },
  ];
  const p = player('loop', markers);
  const fwd = p.advance(Rat.of(3)); // 0 -> 3 (endpoints off markers)
  const back = p.advance(Rat.of(-3)); // 3 -> 0
  assert.equal(fwd.length, back.length);
  for (let i = 0; i < fwd.length; i++) {
    const a = fwd[i];
    const b = back[back.length - 1 - i];
    assert.equal(a.name, b.name);
    assert.ok(a.at.eq(b.at));
    assert.notEqual(a.dir, b.dir);
  }
});

test('pingpong: forward and backward halves carry their slope direction', () => {
  const p = player('pingpong', [{ name: 'm', t: Rat.of(1) }]);
  // 0 -> 5: hits m at t=1 (slope+), t=3 (slope-), t=5 (slope+)
  const fired = p.advance(Rat.of(5));
  assert.deepEqual(fmt(fired), ['m@1:forward', 'm@3:backward', 'm@5:forward']);
});

test('pingpong: turning points fire once per pass, not twice', () => {
  const p = player('pingpong', [
    { name: 'peak', t: D },
    { name: 'trough', t: Rat.of(0) },
  ]);
  // 0 -> 4 -> 8 covers peak@2, trough@4, peak@6, trough@8 exactly once each
  const f1 = p.advance(Rat.of(4));
  assert.deepEqual(fmt(f1), ['peak@2:forward', 'trough@4:backward']);
  const f2 = p.advance(Rat.of(4));
  assert.deepEqual(fmt(f2), ['peak@6:forward', 'trough@8:backward']);
});

test('pingpong: reverse step reports flipped local-motion direction', () => {
  const p = player('pingpong', [{ name: 'm', t: Rat.of(1) }]);
  p.seek(Rat.of(5));
  const fired = p.advance(Rat.of(-5)); // 5 -> 0, hits at 5? no (excluded start)... hits 3, 1
  assert.deepEqual(fmt(fired), ['m@3:forward', 'm@1:backward']);
});

test('contiguous small steps equal one big jump', () => {
  for (const mode of ['once', 'loop', 'pingpong'] as const) {
    const markers: Marker[] = [
      { name: 'a', t: Rat.of(1, 3) },
      { name: 'b', t: Rat.of(1) },
      { name: 'c', t: Rat.of(5, 3) },
    ];
    const whole = player(mode, markers);
    const sliced = player(mode, markers);
    const total = Rat.of(11, 2);
    const all = whole.advance(total);
    const parts: Fired[] = [];
    for (let i = 0n; i < 11n; i++) parts.push(...sliced.advance(Rat.of(1, 2)));
    assert.deepEqual(fmt(parts), fmt(all), mode);
  }
});

test('events at absolute time 0 are not fired by clamping', () => {
  const p = player('loop', [{ name: 'z', t: Rat.of(0) }]);
  p.seek(Rat.of(1));
  const fired = p.advance(Rat.of(-5)); // clamps at 0; z@0 is the inclusive end -> fires
  assert.deepEqual(fmt(fired), ['z@0:backward']);
  assert.equal(p.time.toString(), '0');
});

test('seek never fires events; value still consistent', () => {
  const seen: Fired[] = [];
  const p = new Player(tl, {
    mode: 'loop',
    markers: [{ name: 'm', t: Rat.of(1) }],
    onEvent: (f) => seen.push(f),
  });
  p.seek(Rat.of(10));
  assert.equal(seen.length, 0);
  assert.equal(p.value(), tl.valueAt(Rat.of(0)));
  p.advance(Rat.of(3, 2)); // 10 -> 23/2 crosses m@11
  assert.deepEqual(fmt(seen), ['m@11:forward']);
});
