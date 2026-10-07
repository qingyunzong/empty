# timeaxis

A time-axis library that never mistakes a local wall-clock reading for a
unique point in time. Pure Python 3.11 standard library; tests use
`unittest`.

## Concepts

- **`Instant`** — a unique point on the UTC timeline (epoch seconds).
- **`LocalDateTime`** — a wall-clock reading; resolves to 0, 1 or 2 instants
  only through a transition table.
- **`Duration`** — elapsed timeline seconds.

A **`TransitionTable`** is an explicit, ordered list of UTC-offset segments
(`{"utc_start", "utc_end"?, "offset"}`). Offsets may be any historical value,
including non-whole-hour ones such as `+05:45` or `+08:45:52`. Overlapping
or misordered segments are rejected with `TableError`.

## Key behaviors

- `local_to_instant` returns 0 (gap / forward jump), 1, or 2 (fold /
  backward jump) candidates, each carrying its source segment, sorted
  chronologically.
- `local_interval_to_utc` splits a local interval into the exact union of
  UTC intervals, preserving open/closed boundaries and the source segment of
  every piece (duplicate coverage stays attributable).
- Wall-clock arithmetic (`add_days`, `add_months`, calendar rules with
  day-of-month clamping) and timeline arithmetic (`Instant + Duration`,
  elapsed seconds) are separate operations and must not be interchanged.
- `Timeline.revise` installs a revised table atomically and recomputes only
  the affected cached mappings; `Snapshot` keeps interpreting history with
  the table in effect when it was taken. Illegal (overlapping) revisions are
  rejected atomically — state, revision counter and cache stay untouched.
- `TransitionTable.evidence()` / `timeaxis evidence` emit verifiable
  segmented mapping evidence (UTC range ↔ local range ↔ offset).

## CLI

```sh
python3.11 -m timeaxis validate table.json
python3.11 -m timeaxis evidence table.json
python3.11 -m timeaxis to-instant table.json "2024-03-31T02:30:00"
python3.11 -m timeaxis to-local table.json "2024-03-31T00:30:00Z"
python3.11 -m timeaxis interval table.json START END [--start-bound open] [--end-bound closed]
python3.11 -m timeaxis add-days "2024-01-31T10:00:00" 1
python3.11 -m timeaxis add-months "2024-01-31T10:00:00" 1
python3.11 -m timeaxis add-seconds "2024-03-31T00:00:00Z" 86400
python3.11 -m timeaxis enumerate table.json FROM_UTC TO_UTC
```

All output is JSON; errors are reported as JSON on stderr with exit code 1.

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```

The suite covers gaps, folds, midnight-crossing transitions, consecutive
offset changes, interval endpoints on transitions, candidate ordering,
wall-clock vs timeline arithmetic, incremental revision/cache/snapshot
semantics, atomic rejection, JSON recovery, and a second-by-second
brute-force enumeration cross-check over a short timeline.
