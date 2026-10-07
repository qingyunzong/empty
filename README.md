# rational-anim

Integer-time animation library with exact rational keyframe interpolation (TypeScript, zero dependencies).

## Semantics

- **Integer time, rational values**: keyframes sit at `bigint` timestamps; values are exact `Rational` fractions (`src/rational.ts`), so interpolation never loses precision.
- **Duplicate timestamps**: when several frames share one time, the last declared frame wins.
- **Endpoint hold**: sampling before the first or after the last frame clamps to the endpoint value.
- **Loop modes** (`src/loop.ts`):
  - `repeat`: loops over `[start, end)`; the interval end maps back to the start value.
  - `reverse`: ping-pong with period `2 * duration`; turning points hit the endpoint values exactly once.
- **Logical clock** (`src/clock.ts`): time advances only via `tick(dt)` while running. `pause()`/`resume()` never read the wall clock, so a paused span contributes exactly zero elapsed time.

## Usage

```ts
import { Animation, Clock, Rational, Timeline, keyframe } from "./src/index.js";

const ramp = new Timeline([keyframe(0, Rational.of(0)), keyframe(4, Rational.of(2))]);
const anim = new Animation(ramp, new Clock(), "repeat");

anim.clock.tick(5);          // logical time 5 -> wraps to 1
console.log(anim.value.toString()); // "1/2"
```

## Test

```sh
npm test   # tsc type-check + compile, then node --test
```

Tests verify loop turning points against exact rational reference sequences (`test/loop.test.ts`, `test/clock.test.ts`).
