# rational-sequencer

Sequencer timing library: converts integer ticks to microseconds using a
piecewise tempo map with exact rational arithmetic.

## Design

- **Exact integration**: each tempo segment stores a rational
  `microsecondsPerTick` (bigint-backed). Cumulative time at every segment
  boundary is computed exactly; no floating point is ever used internally.
- **Single rounding**: `tickToMicroseconds` integrates exactly, then applies
  round-half-to-even (banker's rounding) once, at the final step.
- **Tick-stable events**: `Sequencer` stores events at integer ticks. Editing
  tempo means replacing the immutable `TempoMap` (`setTempoMap`) — event
  ticks never move, only their computed playback times change.
- **Reverse lookup**: `microsecondsToTick(us)` returns the earliest tick
  whose exact (unrounded) time is `>= us`, using rational comparison.

## API

```ts
import { Rational, TempoMap, Sequencer } from "./src/index.ts";

const map = TempoMap.fromBpm(480, [
  { tick: 0, bpm: Rational.of(120) },
  { tick: 960, bpm: Rational.of(60) },
]);

map.tickToMicroseconds(960);      // 1_000_000 (exact boundary)
map.timeAt(961);                  // exact Rational
map.microsecondsToTick(1_000_000);  // 960 (earliest matching tick)

const seq = new Sequencer(map);
seq.addEvent(480, "note-on");
seq.setTempoMap(otherMap);        // ticks unchanged, times recomputed
```

## Test

```
npm test
```

Runs `tsc` typecheck, compiles to `dist/`, and executes `node --test`.
Tests validate monotonicity and segment boundaries against an independent
naive rational reference implementation.
