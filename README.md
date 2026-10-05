# rational-anim

Keyframe animation library with **exact rational-number time** (bigint
fractions), explicit loop/pingpong boundary semantics, seek/reverse-consistent
evaluation, and direction-aware event callbacks. TypeScript + Node.js built-ins
only (compiled with `tsc`, tested with `node:test`; zero runtime dependencies).

## Model

- **Time is a rational** `n/d` (`src/rational.ts`), always normalized
  (`d > 0`, `gcd(|n|, d) = 1`). All arithmetic is exact; conversion to
  `number` happens only at the final interpolation step.
- **Track** (`src/timeline.ts`): sorted keyframes at rational times, piecewise
  interpolation between them with a per-segment easing. Evaluation is a pure
  function of time: clamped outside the key range, and a keyframe time is
  owned by the segment to its right, so the value at a key is exact no matter
  which side you approach from.
- **Time mapping** (`src/mapping.ts`), duration `D`, defined for *every*
  rational `t` (negative times included):
  - `once`: `local = clamp(t, 0, D)`
  - `loop`: `local = t mod D ∈ [0, D)` — multiples of `D` map to `0`; the end
    keyframe is only the left-limit as `t → D⁻`
  - `pingpong`: period `2D`, `m = t mod 2D`; `local = m` on `[0, D]`,
    `local = 2D − m` on `(D, 2D)` — peak and trough are each attained at
    exactly one instant per period
- **Player** (`src/player.ts`): a stateful playhead whose value is always
  `track.evaluate(mapTime(time).local)`. Because there is no integrated or
  cached interpolation state, **arbitrary seeks, huge jumps and reverse
  playback produce exactly the same value as direct evaluation** at the same
  time.

## Events

Events sit at local timeline times (`[0, D)` for `loop`, `[0, D]` otherwise).
A playhead move `t0 → t1` fires each crossed event **once**, tagged with the
travel direction, using half-open intervals:

- forward (`t1 > t0`): occurrences in `(t0, t1]`
- backward (`t1 < t0`): occurrences in `[t1, t0)`

Departure points belong to the interval just left, arrival points to the
interval just entered. Consequences, all covered by tests: consecutive moves
never double-fire or skip; partitioning a jump into steps fires the same
multiset; moving `a→b→a` fires each crossed point exactly once per direction.
In `pingpong`, an event fires on both the forward and return passes (peak and
trough events once per period, not twice).

## Usage

```ts
import { Player, Track, keyframe, rat, easeInQuad } from "./src/index.js";

const track = new Track([
  keyframe(0, 1, 0),
  keyframe(1, 3, 2, easeInQuad),
  keyframe(3, 2, 4),
]);
const player = new Player({
  track,
  mode: "pingpong",
  events: [{ name: "beat", time: rat(1, 4) }],
  onEvent: (c) => console.log(c.name, c.direction),
});
player.advance(rat(7, 8));      // exact rational step
player.seek(rat(-1000, 7));     // arbitrary jump, reverse included
player.value();                 // === track.evaluate(mapTime(player.time).local)
```

## Tests

`npm test` compiles with `tsc` and runs `node --test`:

- `test/rational.test.ts` — normal form, exact arithmetic, `floorDiv`/`mod`
  identities, 500 randomized field-identity checks
- `test/timeline.test.ts` — exact keyframe hits, clamping, easing, segment
  endpoint ownership
- `test/mapping.test.ts` — boundary tables for all three modes (incl. negative
  times), plus 1000 randomized periodicity/symmetry checks
- `test/player.test.ts` — 2000-step random walks per mode (mixed small steps
  and huge jumps) asserting `player.value()` equals direct evaluation and the
  playhead equals the exact accumulated sum; 1500 random jumps per mode whose
  fired events are compared **exactly** (names, rational times, directions,
  order) against an independently written interval-membership oracle;
  exactly-once partition, round-trip mirroring, and boundary-convention tests

### Recorded result (Node v22.22.1, 2026-10-05)

```
# Subtest: dist/test/mapping.test.js
ok 1 - dist/test/mapping.test.js
# Subtest: dist/test/player.test.js
ok 2 - dist/test/player.test.js
# Subtest: dist/test/rational.test.js
ok 3 - dist/test/rational.test.js
# Subtest: dist/test/timeline.test.js
ok 4 - dist/test/timeline.test.js
# tests 4
# pass 4
# fail 0
```

`test/player.test.js` in detail:

```
ok 1 - seek/reverse consistency: player value always equals direct evaluation
ok 2 - events: random steps and large jumps match the interval model exactly
ok 3 - events fire exactly once: partitioning a jump changes nothing
ok 4 - forward then immediate backward mirrors crossings with flipped direction
ok 5 - boundary convention: departure belongs to previous interval, arrival to next
ok 6 - onEvent callback receives exactly the seek() crossings, in order
ok 7 - event validation: loop events must lie in [0, D)
```
