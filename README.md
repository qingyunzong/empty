# device-window-stats

Single-node, offline device up/down window statistics. Node.js 22 standard
library only; tests use `node:test`.

## Model

- Events: `{id, device, ts, state}` with `state` in `{up, down}`; `ts` is epoch
  seconds (ISO-8601 accepted by the CLI).
- Before a device's first event the state is `null` (unknown): unknown time is
  neither uptime nor downtime.
- Fixed 15-minute windows (900s). Per window: `uptime + downtime + unknown = 900`.
  A fully unknown window reports `uptime: null, downtime: null`.
- Events arrive incrementally behind a watermark. A late event is inserted by
  key `(ts, id)`; every affected window is retracted and republished with a
  bumped `version`. Only the latest version per `(device, window)` is live, so
  corrections never double count. Duplicate event ids are ignored.

## Durability

Append-only log (`events.log`) + snapshot index (`index.json` = `{offset, events}`):

- crash **before append** -> the batch has zero effect;
- crash **after append, before index** -> on restart `Store.open()` replays the
  log tail beyond the indexed offset and applies the batch exactly once.

`compact` folds the log into the snapshot and truncates the log.

## CLI

```
node src/cli.js append  --dir DIR [--file events.json|jsonl] [--crash=before-append|after-append]
node src/cli.js query   --dir DIR --device ID --from TS --to TS
node src/cli.js compact --dir DIR
```

`append` reads a JSON array or JSONL (file or stdin) and prints
`{"appended":N,"offset":M}`. `query` prints one JSON window per line including
its correction `version`. Injected crashes exit with code 75.

## Library

- `src/windows.js` — `Timeline`, `aggregateWindow`, `Aggregator` (watermark,
  retraction/correction journal in `aggregator.corrections`).
- `src/store.js` — `Store` (append-only log, replay, compact) and `CrashInjected`.
- `src/reference.js` — reference algorithm: sorts events independently and
  scans every window second by second; the tests cross-check the incremental
  engine against it.

## Tests & acceptance record

```
node --test                  # 3 acceptance scenario tests
npm run record               # regenerate result.txt from real CLI runs
```

`result.txt` holds the real stdout, stderr and exit code of every CLI command
for the three acceptance scenarios plus the `node --test` run.
