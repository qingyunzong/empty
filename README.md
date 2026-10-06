# sample-qc-joiner

Event-time tumbling-window join of scientific-instrument events, with a durable
state log and crash recovery. Node.js 22, standard library only, tests via `node:test`.

## Model

- Instruments emit `SAMPLE_ACQUIRED` and `QC_RESULT` events.
- Events are joined by `sampleId` inside 5-minute event-time tumbling windows
  (`JOINED` is published only when both sides exist in the same window).
- When a `WATERMARK` closes a window, any event still unmatched is emitted as
  `EXPIRED_UNJOINED`.
- Records are `UPSERT` / `RETRACT`. Retracting one side before the window closes
  cascades a `WITHDRAW` of the join and re-judges the remaining side.
- Records whose window is already closed are reported as `LATE`.
- Reference matching algorithm: per window, enumerate both side sets and
  brute-force pair events sharing a `sampleId` in `(eventTime, eventId)` order.

## Input (NDJSON on stdin)

```json
{"type":"UPSERT","eventType":"SAMPLE_ACQUIRED","eventId":"e1","sampleId":"s1","eventTime":1000}
{"type":"UPSERT","eventType":"QC_RESULT","eventId":"q1","sampleId":"s1","eventTime":60000}
{"type":"RETRACT","eventType":"SAMPLE_ACQUIRED","eventId":"e1","eventTime":1000}
{"type":"WATERMARK","time":300000}
```

## CLI

```sh
node src/cli.js --state state.log [--crashAfter N] [--recover] < input.ndjson
```

- Every valid record is persisted with `appendFileSync` **before** it is
  processed; its results are then committed to the log before being emitted.
- `--crashAfter N`: exit with code 101 right after the Nth valid record is
  persisted, before its results are produced.
- `--recover`: replay the state log. Committed records rebuild state without
  re-emitting (their results must not be duplicated); the crashed record is
  processed from the log; remaining records are read from stdin (the first
  records already present in the log are skipped). Concatenating the crashed
  run's stdout with the recovery run's stdout yields exactly the no-crash output.

## Errors

Errors are written to stderr as JSON and exit with code 2:
`MALFORMED`, `UNKNOWN_RETRACT`, `DURABLE_STATE_CORRUPT`.

## Tests

```sh
node --test
```

See `test-results.txt` for a recorded run (stdout, stderr, exit code).
