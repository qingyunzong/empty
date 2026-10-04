# weather-sessionizer

Node.js 22 library + CLI (standard library only) that sessionizes weather
station observations from a JSONL stream of `UPSERT` / `RETRACT` /
`WATERMARK` records, in arrival order.

## Usage

```sh
node src/cli.js sessions --in data.jsonl
node --test   # run the test suite
```

Finalized sessions are written to stdout as JSONL; rejected records are
written to stderr as JSON; fatal errors (bad usage, unreadable file,
malformed JSON, invalid record shape) print `{"fatal":true,...}` to stderr
and exit with code 2.

## Input records

```json
{"op":"UPSERT","id":"a","station":"s1","eventTime":"2026-01-01T00:00:00Z","temp":21.5,"version":1}
{"op":"RETRACT","id":"a","version":2}
{"op":"WATERMARK","ts":"2026-01-01T01:00:00Z"}
```

`eventTime` / `ts` accept ISO-8601 strings or epoch milliseconds.

## Session semantics

- Sessions are maintained per station over event time: two adjacent live
  observations more than 10 minutes apart belong to different sessions,
  otherwise they merge. Out-of-order inserts can therefore merge sessions,
  and a `RETRACT` can split one session into several.
- A watermark `W` finalizes every session whose maximum event time is
  strictly more than 10 minutes behind `W` (`W > maxEventTime + 10min`).
  Finalized sessions are emitted as:

  ```json
  {"station":"s1","start":"...","end":"...","count":3,"avgTemp":20.5,"ids":["a","b","c"],"version":2}
  ```

  `version` is the maximum version among the member observations.
- Once a watermark `W` has been seen, any `UPSERT` with `eventTime <= W`,
  and any `RETRACT` of an observation at or before `W` (including already
  finalized observations), is rejected with a `LATE` error and does not
  change state.
- Versioning per observation id: a record with a lower version than the
  known one is rejected with `STALE_VERSION`; an identical version is an
  idempotent no-op; a higher version is applied. Retracting a never-seen id
  is rejected with `UNKNOWN_RETRACT`.

## Error output

```json
{"error":"LATE","message":"...","line":7,"record":{...}}
```

Error codes: `LATE`, `STALE_VERSION`, `UNKNOWN_RETRACT` (record level,
processing continues, exit code stays 0); `USAGE`, `IO`, `INVALID_JSON`,
`INVALID_RECORD` (fatal, exit code 2).

## Layout

- `src/sessions.js` — library (`SessionProcessor`, `normalizeRecord`)
- `src/cli.js` — CLI entry point
- `test/sessions.test.js` — acceptance tests plus a randomized differential
  test against an independent brute-force reference (sorts the live points,
  enumerates all valid gap groupings, computes means from scratch; no code
  shared with the implementation)
- `test/cli.test.js` — CLI end-to-end tests
