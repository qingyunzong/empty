# offset-clock

Local integer-second ↔ UTC mapping driven **solely** by an input offset
transition table. The system timezone is never consulted.

## Model

A `TransitionTable` is an initial offset plus transitions
`{ atUtc, offsetSeconds }`, strictly increasing in `atUtc`. The effective
offset rules form half-open UTC domains:

- rule 0: `initialOffsetSeconds` over `(-∞, transitions[0].atUtc)`
- rule k: `transitions[k-1].offsetSeconds` over
  `[transitions[k-1].atUtc, transitions[k].atUtc)`

All times are integer seconds; all intervals are half-open `[start, end)`.
Tables are validated and deep-frozen on creation.

## API

- `utcToLocal(table, utc)` — forward map, always total; reports the source
  offset rule.
- `localToUtc(table, local)` — reverse map. Returns `kind`:
  - `"unique"` — exactly one UTC candidate;
  - `"ambiguous"` — the local second falls in an overlap (offset jumped
    back); `candidates` holds every UTC solution (two for real-world tables,
    more for exotic rapid consecutive transitions);
  - `"none"` — the local second falls in a gap (offset jumped forward);
    explicitly no solution.
- `localIntervalToUtc(table, localStart, localEnd)` — inverse image of a
  local half-open interval: every UTC second whose local image lies in
  `[localStart, localEnd)`. The result is split wherever a transition is
  crossed (gaps contribute nothing, overlaps contribute one segment per
  covering rule), and adjacent segments with the same offset rule are merged
  into one equivalent segment. Each segment carries `offsetSeconds` and the
  source `ruleIndices`.
- `verifyRoundTrip(table, utcStart, utcEnd)` — exhaustively forward-maps
  every UTC second in the domain and confirms the reverse lookup contains it.
- `verifyInverseImage(table, localStart, localEnd)` — exhaustively checks,
  over the preimage's short UTC domain plus padding, that
  `u ∈ preimage ⟺ localStart ≤ utcToLocal(u) < localEnd`.
- `Zone` / `ZoneCursor` — `zone.updateTable(table)` atomically swaps the
  whole immutable table and bumps the version. Cursors bind the table at
  creation: old cursors keep answering with the old table, new cursors see
  the new one.

## Test

```sh
npm test   # tsc typecheck+build, then node --test on the compiled suite
```
