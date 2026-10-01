# walwin

WAL-backed sliding-window sum over JSONL records `{seq, key, ts, delta}`.
Python 3.11+ standard library only.

## CLI

```
python -m walwin --in e.jsonl --dir state --win 60000
```

- `--in`: input JSONL file of `{seq, key, ts, delta}` records.
- `--dir`: state directory holding `wal.log` and `snapshot.json` (created if missing).
- `--win`: window width in milliseconds.

Output (stdout, one JSON line): the sum of `delta` over applied records with
`ts` in the final window `(max_ts - win, max_ts]`:

```json
{"window_sum": 28, "max_ts": 120000, "win": 60000, "applied": 5}
```

Exit codes: `0` success; `3` state directory not writable.

## Semantics

- Each record is first appended to `wal.log` as a CRC32-tagged entry carrying
  its `seq`; it is applied only after a `commit` marker for that `seq` is
  appended and fsynced.
- Recovery truncates a corrupt WAL tail (bad CRC / torn write) and skips
  duplicate `seq` values idempotently.
- `snapshot.json` contains only committed records forming the contiguous seq
  prefix `1..last_seq`; committed records beyond a gap stay pending in the WAL
  and are never reported as unsatisfiable.
- Snapshotting writes `snapshot.tmp`, fsyncs, renames to `snapshot.json`, then
  rewrites the WAL keeping only still-pending records.

## Fault points (simulated via `FAULT_AT=P1..P4`)

| Point | Location                                   | Recovery equivalence            |
|-------|--------------------------------------------|---------------------------------|
| P1    | WAL record appended, not yet fsynced       | record never happened           |
| P2    | record fsynced, commit marker not written  | record never happened           |
| P3    | `snapshot.tmp` renamed, WAL not yet cleared| record happened; WAL clearable  |
| P4    | state durable, output not yet emitted      | output re-sent, no double count |

## Tests

```
python -m unittest discover -v
```

See `RESULTS.md` for the recorded run.
