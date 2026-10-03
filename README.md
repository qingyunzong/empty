# charge-leaderboard

Event-time streaming leaderboard over 10-minute tumbling windows. Probes submit
`TRIGGER` events (`channel`, `ts`, `charge`) and `WATERMARK` events; the system
keeps a per-window total charge per channel and continuously publishes the top-3
channels. Node.js 22, standard library only.

## Usage

```sh
node src/cli.js triggers --in events.jsonl
```

- stdout: one JSON leaderboard action per line (`ADD` / `WITHDRAW`).
- stderr: one JSON error object per line; the process exits with code `2` if any
  error occurred (`0` otherwise).

## Input format (JSONL)

```json
{"type":"TRIGGER","eventId":"e1","version":1,"op":"UPSERT","channel":"alpha","ts":1000,"charge":12.5}
{"type":"TRIGGER","eventId":"e1","version":2,"op":"RETRACT"}
{"type":"WATERMARK","ts":600000}
```

- Windows are 10-minute tumbling windows aligned to the epoch
  (`[floor(ts/600000)*600000, +600000)`), lateness allowed is 0: a `WATERMARK`
  reaching a window's end closes it, and later events for that window are
  rejected as `LATE`.
- `charge` must be a finite non-negative number (`INVALID_CHARGE`).
- Per `eventId`, a higher `version` overrides a lower one; a non-increasing
  version is rejected as `STALE_VERSION`; retracting an unknown `eventId` is
  rejected as `UNKNOWN_RETRACT`.

## Output format (JSONL)

```json
{"type":"ADD","window":{"start":0,"end":600000},"top":[{"channel":"alpha","total":12.5}],"certificate":{"eventIds":["e1"],"totals":{"alpha":12.5}}}
{"type":"WITHDRAW","window":{"start":0,"end":600000},"top":[...],"certificate":{...}}
```

- `top` holds at most 3 entries ordered by total charge descending; ties are
  broken by channel name in lexicographic order.
- While a window is open, every change to the published board is emitted as a
  `WITHDRAW` of the old board followed by an `ADD` of the new board.
- The `certificate` lists every participating `eventId` (sorted) and the total
  charge per channel, so the board can be verified independently.

## Library

```js
const { LeaderboardEngine } = require('./src/engine');
const engine = new LeaderboardEngine();
const actions = engine.apply(event); // throws EngineError with .code on rejection
```

## Tests

```sh
node --test
```

`test/reference.test.js` contains an independent brute-force reference (per-window
sums, full leaderboard enumeration) that shares no code with `src/engine.js` and
is cross-checked against the engine on randomized streams.
