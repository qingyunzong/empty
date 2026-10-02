# oee-tracker

Offline, single-machine device-state interval engine with incremental session
merging, per-shift OEE metrics, undo/redo and a deterministic version hash.
Node.js 22, standard library only, tests via `node:test`.

## Model

- A device emits **intervals** `[start, end)` (half-open) with a state of
  `RUN`, `IDLE`, `FAIL` or `MAINT`. Timestamps are ISO 8601 strings or epoch ms.
- Intervals of the same device must **not overlap**. Any state may follow any
  other state.
- Errors (structured, machine-readable `code`):
  - `OVERLAP` — interval overlaps an existing one
  - `BACKWARD_CLOCK` — `end <= start`
  - `UNKNOWN_STATE` — state not in `RUN|IDLE|FAIL|MAINT`
  - plus `UNKNOWN_ID`, `DUPLICATE_ID`, `INVALID_EVENT`, `INVALID_TIME`,
    `INVALID_COMMAND`, `INVALID_INPUT`, `INVALID_ARGS`, `INVALID_JSON`,
    `FILE_NOT_FOUND`, `FILE_READ_ERROR`
- **Sessions** merge adjacent (`end === start`) intervals of the same state.
- **Shift metrics** per shift window: `runMs`, `failMs` and
  `availability = runMs / shiftWindowMs` (rounded to 6 decimals).

## Incremental maintenance

`Store` keeps intervals sorted and sessions/materialized metrics up to date.
On `append` / `correct` / `delete` (and their undo/redo inverses) it computes
the affected time window from the changed intervals plus their adjacency
chains, rebuilds **only** the sessions intersecting that window, and adjusts
only the metrics of shifts overlapping it. Every command returns a diff:
removed/added sessions and per-shift before/after metrics.
`test/engine.test.js` proves equivalence with a brute-force full-sort
recompute (`src/reference.js`), including randomized out-of-order workloads.

## CLI

```
node src/cli.js oee events.json commands.json -o out.json
```

- `events.json`: `{ "shifts": [{id,start,end}], "events": [{id?,start,end,state}] }`
  (events may arrive out of order / late).
- `commands.json`: array of
  `{op:"append",event}`, `{op:"correct",id,event}`, `{op:"delete",id}`,
  `{op:"undo"}`, `{op:"redo"}`.
- `out.json`: `{ version, sessions, shifts, diffs }` where `version` is a
  deterministic SHA-256 hash of the canonical interval+shift state.
- Exit code `0` on success; `1` on file/JSON/validation errors, with a
  structured error on stderr: `{"error":{"code","message","details?"}}`.

Try it:

```
node src/cli.js oee examples/events.json examples/commands.json -o /tmp/out.json
```

## Tests

```
node --test
```

`test-results.txt` records a real `node --test` run (stdout, stderr, exit code).
