# rational-anim

Keyframe animation on **integer time** with **exact rational interpolation**
(BigInt-backed fractions, no floating-point drift).

## Semantics

- **Integer time**: all timestamps and clock positions are integers
  (`bigint` internally); non-integer input is rejected.
- **Rational keyframe interpolation**: values are exact fractions; linear
  interpolation between keyframes is computed rationally.
- **Duplicate timestamps**: when several keyframes share a time, the last
  one wins.
- **Endpoint clamping**: before the first keyframe the first value holds,
  at/after the last keyframe the last value holds.
- **Forward loop** (`loop`): time wraps over `[start, end)`; the interval
  end maps back to the start.
- **Reverse loop** (`reverse`): defined separately as a ping-pong mapping
  `start -> end -> start` with period `2 * (end - start)`, touching both
  endpoints exactly once per turn.
- **Pause/resume without wall clock**: `Clock` advances only via explicit
  `tick(delta)` calls; `pause()`/`resume()` never read the wall clock, so
  sequences are exactly reproducible.

## Usage

```ts
import { Animation, Clock, Fraction, Track } from "./src/index.js";

const track = new Track([
  { time: 0, value: 0 },
  { time: 4, value: 1 },
]);

const anim = new Animation(track, { mode: "loop", region: { start: 0, end: 4 } });
anim.valueAt(1); // Fraction 1/4
anim.valueAt(4); // Fraction 0 (loop end maps to start)

const clock = new Clock();
clock.tick(3);
clock.pause();
clock.tick(10); // no-op while paused
clock.resume(); // resumes exactly at 3, no wall-clock catch-up
```

## Test

```sh
npm test
```

Compiles with `tsc` and runs the `node:test` suite, including exact
rational reference checks across the loop turning points.
