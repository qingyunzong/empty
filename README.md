# local-utc-timezone

A small TypeScript timezone library driven entirely by a caller-supplied
offset transition table. It never reads the system timezone. All timestamps
are integer seconds and all intervals are half-open `[start, end)`.

```
local = utc + offsetSeconds
```

## Concepts

- `TransitionTable` — immutable list of offset rules derived from an initial
  offset plus strictly increasing UTC transition points. Consecutive
  transitions must actually change the offset.
- `TimezoneDatabase` — holds the current table. `replace()` is a single
  atomic reference swap; readers always see one consistent table.
- `TransitionCursor` — iterates a table's transitions and stays bound to the
  exact table version it was created from, even after `replace()`.

## API overview

- `table.utcToLocal(utc)` — forward map, always exactly one answer.
- `table.localToUtc(local)` — inverse map for one local second:
  - `{ kind: "none" }` inside a gap (explicitly no solution),
  - `{ kind: "unique", utcSecond }` normally,
  - `{ kind: "ambiguous", utcSeconds: [a, b] }` inside an overlap.
- `table.inverseImage(localStart, localEnd)` — every UTC interval whose
  forward image lands in the local interval. Pieces are split per source
  offset rule (dropping local seconds inside gaps) and adjacent/overlapping
  pieces are merged into connected segments; each segment's `parts` record
  the source `OffsetRule` of every piece.
- `table.verifyForward(utcStart, utcEnd)` — exhaustively round-trips every
  UTC second in a small domain (`utcToLocal` then `localToUtc`).
- `verifySegment(table, segment, localStart, localEnd, maxExhaustive)` —
  exhaustively checks one inverse-image segment against its local interval;
  domains larger than `maxExhaustive` are reported as non-exhaustive.

## Example

```ts
import { TransitionTable, verifySegment } from "./src/timezone.js";

const table = new TransitionTable(3600, [
  { utcSecond: 1000, offsetSeconds: 7200 }, // spring forward: local gap
  { utcSecond: 5000, offsetSeconds: 3600 }, // fall back: local overlap
]);

table.localToUtc(5000);            // { kind: "none" } — inside the gap
table.localToUtc(9000);            // { kind: "ambiguous", utcSeconds: [1800, 5400] }

const segments = table.inverseImage(4000, 13000);
for (const segment of segments) {
  verifySegment(table, segment, 4000, 13000); // exhaustive check per segment
}
```

## Tests

```
npm test
```

Compiles with `tsc` (TypeScript 7) and runs the `node:test` suite in
`test/timezone.test.ts`. No runtime dependencies.
