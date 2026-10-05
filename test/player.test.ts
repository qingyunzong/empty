import { test } from "node:test";
import assert from "node:assert/strict";
import { Player } from "../src/player.js";
import { Track, keyframe } from "../src/timeline.js";
import { easeInQuad } from "../src/easing.js";
import { mapTime, PlayMode } from "../src/mapping.js";
import { EventCrossing, TimelineEvent } from "../src/events.js";
import {
  Rational, ZERO, add, cmp, floorDiv, key, rat, scale, sub,
} from "../src/rational.js";
import { mulberry32, randInt, randomRational } from "./helpers.js";

/**
 * Interval-model oracle: the expected crossings of a move t0 -> t1 computed
 * directly from set membership in the half-open interval, with occurrence
 * times enumerated per (event, cycle) pair. Written independently from the
 * library implementation; tests below assert exact agreement.
 */
function intervalModel(
  events: readonly TimelineEvent[],
  t0: Rational,
  t1: Rational,
  duration: Rational,
  mode: PlayMode,
): Array<{ name: string; at: string; direction: string }> {
  const order = cmp(t0, t1);
  if (order === 0) return [];
  const forward = order < 0;
  const lo = forward ? t0 : t1;
  const hi = forward ? t1 : t0;
  const period = mode === "pingpong" ? scale(duration, 2n) : duration;

  const inside = (at: Rational): boolean =>
    forward
      ? cmp(at, lo) > 0 && cmp(at, hi) <= 0 // (lo, hi]
      : cmp(at, lo) >= 0 && cmp(at, hi) < 0; // [lo, hi)

  const out: Array<{ name: string; at: Rational; direction: string; seq: number }> = [];
  events.forEach((ev, seq) => {
    const seen = new Set<string>();
    const kLo = mode === "once" ? 0n : floorDiv(lo, period) - 1n;
    const kHi = mode === "once" ? 0n : floorDiv(hi, period) + 1n;
    for (let k = kLo; k <= kHi; k++) {
      const occs: Rational[] = [];
      if (mode === "once") {
        if (k === 0n) occs.push(ev.time);
      } else if (mode === "loop") {
        occs.push(add(ev.time, scale(duration, k)));
      } else {
        const p = scale(period, k);
        occs.push(add(ev.time, p));
        occs.push(add(sub(period, ev.time), p));
      }
      for (const at of occs) {
        if (!inside(at)) continue;
        const id = key(at);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ name: ev.name, at, direction: forward ? "forward" : "backward", seq });
      }
    }
  });
  out.sort((a, b) => {
    const c = cmp(a.at, b.at);
    if (c !== 0) return forward ? c : -c;
    return a.seq - b.seq;
  });
  return out.map((o) => ({ name: o.name, at: key(o.at), direction: o.direction }));
}

const simplify = (cs: EventCrossing[]) =>
  cs.map((c) => ({ name: c.name, at: key(c.at), direction: c.direction }));

const track = new Track([
  keyframe(0, 1, 0),
  keyframe(1, 3, 2, easeInQuad),
  keyframe(5, 6, -1),
  keyframe(3, 2, 4),
]);
const D = track.duration; // 3/2

const events: TimelineEvent[] = [
  { name: "start", time: ZERO },
  { name: "third", time: rat(1, 3) },
  { name: "half", time: rat(3, 4) },
  { name: "near-end", time: rat(17, 12) },
];

test("seek/reverse consistency: player value always equals direct evaluation", () => {
  const rnd = mulberry32(2026);
  for (const mode of ["once", "loop", "pingpong"] as const) {
    const player = new Player({ track, mode });
    let accumulated = ZERO;
    for (let i = 0; i < 2000; i++) {
      // Mix of small random steps and rare huge jumps (up to ~10^6 * D).
      const delta =
        rnd() < 0.15
          ? randomRational(rnd, 2_000_000, 3)
          : randomRational(rnd, 48, 12);
      player.advance(delta);
      accumulated = add(accumulated, delta);
      assert.ok(
        cmp(player.time, accumulated) === 0,
        `${mode}: time drift after step ${i}`,
      );
      const direct = track.evaluate(mapTime(player.time, D, mode).local);
      assert.equal(player.value(), direct, `${mode}: value mismatch at step ${i}`);
    }
  }
});

test("events: random steps and large jumps match the interval model exactly", () => {
  const rnd = mulberry32(99);
  for (const mode of ["once", "loop", "pingpong"] as const) {
    const evs =
      mode === "loop" ? events.filter((e) => e.name !== "near-end" || true) : events;
    const usable = mode === "loop" ? evs.filter((e) => cmp(e.time, D) < 0) : evs;
    const player = new Player({ track, mode, events: usable });
    for (let i = 0; i < 1500; i++) {
      const target =
        rnd() < 0.2
          ? randomRational(rnd, 4_000, 6) // huge jump (hundreds of cycles), either direction
          : add(player.time, randomRational(rnd, 60, 8));
      const t0 = player.time;
      const got = simplify(player.seek(target));
      const want = intervalModel(usable, t0, target, D, mode);
      assert.deepEqual(got, want, `${mode}: crossing mismatch on jump ${i}`);
    }
  }
});

test("events fire exactly once: partitioning a jump changes nothing", () => {
  const rnd = mulberry32(5);
  for (const mode of ["loop", "pingpong"] as const) {
    const usable = events.filter((e) => cmp(e.time, D) < 0);
    const t0 = randomRational(rnd, 100, 6);
    const t2 = add(t0, randomRational(rnd, 5000, 3));
    const t1 = add(t0, randomRational(rnd, 200, 7));
    const whole = intervalModel(usable, t0, t2, D, mode);
    const parts = [
      ...intervalModel(usable, t0, t1, D, mode),
      ...intervalModel(usable, t1, t2, D, mode),
    ];
    assert.deepEqual(parts, whole, `${mode}: partition mismatch`);
  }
});

test("forward then immediate backward mirrors crossings with flipped direction", () => {
  const usable = events.filter((e) => cmp(e.time, D) < 0);
  // Departure/arrival chosen to not coincide with any event occurrence, so
  // the round trip crosses exactly the same event points in both directions.
  const origin = rat(1, 7);
  const target = rat(1000, 7);
  for (const mode of ["loop", "pingpong"] as const) {
    const player = new Player({ track, mode, events: usable, startTime: origin });
    const fwd = simplify(player.seek(target));
    const back = simplify(player.seek(origin));
    assert.ok(fwd.length > 0);
    const mirrored = [...fwd].reverse().map((c) => ({ ...c, direction: "backward" }));
    assert.deepEqual(back, mirrored, `${mode}: reverse not mirrored`);
  }
});

test("boundary convention: departure belongs to previous interval, arrival to next", () => {
  // loop, D = 3/2, event "half" at local 3/4 (global occurrences 3/4 + k*3/2).
  const evs = [{ name: "half", time: rat(3, 4) }];
  const log: string[] = [];
  const player = new Player({
    track,
    mode: "loop",
    events: evs,
    onEvent: (c) => log.push(`${c.name}@${key(c.at)}:${c.direction}`),
  });
  player.seek(rat(3, 4)); // forward arrival exactly on the event: fires
  player.seek(rat(3, 2)); // departing past it: no refire of the point behind
  player.seek(rat(3, 4)); // backward arrival exactly on it: fires backward
  player.seek(rat(0)); // 3/4 is the departure point now: excluded, no fire
  player.seek(rat(2)); // forward over 3/4 again (9/4 > 2 not reached)
  player.seek(rat(3, 4)); // backward arrival on it once more
  assert.deepEqual(log, [
    "half@3/4:forward",
    "half@3/4:backward",
    "half@3/4:forward",
    "half@3/4:backward",
  ]);
});

test("onEvent callback receives exactly the seek() crossings, in order", () => {
  const seen: EventCrossing[] = [];
  const player = new Player({
    track,
    mode: "pingpong",
    events,
    onEvent: (c) => seen.push(c),
  });
  const returned = player.seek(rat(25, 2)); // spans many pingpong periods
  assert.deepEqual(seen, returned);
  assert.ok(returned.length > 10);
  // Directions of traversal are all "forward" for a forward jump...
  assert.ok(returned.every((c) => c.direction === "forward"));
  // ...and occurrence times are non-decreasing.
  for (let i = 1; i < returned.length; i++) {
    assert.ok(cmp(returned[i - 1]!.at, returned[i]!.at) <= 0);
  }
});

test("event validation: loop events must lie in [0, D)", () => {
  assert.throws(
    () => new Player({ track, mode: "loop", events: [{ name: "x", time: D }] }),
  );
  assert.throws(
    () => new Player({ track, mode: "pingpong", events: [{ name: "x", time: rat(-1, 2) }] }),
  );
  // Peak event is legal in pingpong and fires once per period.
  const player = new Player({
    track,
    mode: "pingpong",
    events: [{ name: "peak", time: D }],
  });
  const crossings = player.seek(rat(6)); // 2 full periods of 2D=3
  assert.equal(crossings.filter((c) => c.name === "peak").length, 2);
});
