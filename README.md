# oee-tracker

Device-state interval tracking with incremental session merging and per-shift OEE
metrics. Node.js 22, standard library only (`node:test` for tests). Fully offline,
single-machine CLI.

## Model

- A device emits **half-open intervals** `[start, end)` with a state of
  `RUN`, `IDLE`, `FAIL` or `MAINT`. Times are ISO-8601 strings (or epoch ms).
- Intervals of the same device must **not overlap**. `end <= start` is a
  backward-clock error. Unknown states are rejected. Any state may follow any
  other state.
- Adjacent same-state intervals (`a.end === b.start`) merge into **sessions**.
- **Shifts** are fixed windows (default 8 h from the Unix epoch; configurable via
  `shift.anchor` / `shift.lengthHours` / `shift.lengthMs` in `events.json`).
  Per device and shift the engine tracks `runMs`, `idleMs`, `failMs`, `maintMs`,
  `plannedMs = run + idle + fail` and `availability = runMs / plannedMs`
  (`null` when nothing was planned). `MAINT` is excluded from planned time.
- History may arrive late, out of order, or be corrected. Every mutation only
  rebuilds the sessions and shift buckets that overlap the changed time window
  (expanded across adjacency merge boundaries); everything else is untouched.
- `version` is a deterministic SHA-256 over the canonical JSON of
  `{intervals, sessions, shifts}` — identical states always hash identically,
  regardless of arrival order.

## CLI

```
node src/cli.js oee events.json commands.json -o out.json
```

- Success: exit code `0`, one-line JSON summary on stdout, full result written
  to `out.json` (`ok`, `version`, `intervals`, `sessions`, `shifts`, `diff` —
  one entry per applied command with added/removed sessions and before/after
  shift metrics).
- Any failure (bad usage, unreadable file, malformed JSON, overlap, unknown
  state, backward clock, unknown id, empty undo/redo stack): exit code `1` and a
  structured error on stderr, e.g.
  `{ "ok": false, "error": { "code": "OVERLAP", "message": "...", "details": ... } }`.
  No output file is written on failure.

### events.json

```json
{
  "shift": { "anchor": "2024-01-01T00:00:00Z", "lengthHours": 8 },
  "intervals": [
    { "id": "e1", "device": "press-1", "start": "2024-01-01T06:00:00Z", "end": "2024-01-01T08:00:00Z", "state": "RUN" }
  ]
}
```

`shift` and `intervals` are optional; intervals without `id` get `evt-<index>`.

### commands.json

A JSON array (or `{ "commands": [...] }`) of:

```json
[
  { "op": "append",  "interval": { "id": "e2", "device": "press-1", "start": "...", "end": "...", "state": "FAIL" } },
  { "op": "correct", "id": "e2", "interval": { "end": "...", "state": "IDLE" } },
  { "op": "delete",  "id": "e2" },
  { "op": "undo" },
  { "op": "redo" }
]
```

`append` auto-assigns ids when omitted. `correct` merges the given fields over
the existing interval (id stays). `undo`/`redo` walk the command history and
fail with `NOTHING_TO_UNDO` / `NOTHING_TO_REDO` when the stack is empty.

## Library

- `src/engine.js` — `Engine`: `loadEvents`, `executeCommand`, `snapshot`.
- `src/reference.js` — `computeReference(intervals, opts)`: independent
  sort-and-recompute implementation used by the tests to cross-check the
  incremental engine.
- `src/model.js` — validation, error type (`OeeError` with `code`), canonical
  JSON.

## Tests

```
node --test
```

Covers: out-of-order backfill merging with per-step comparison against the full
recompute reference, retroactive corrections propagating across shift
boundaries, overlap / unknown-state / backward-clock rejection, session
splitting, undo/redo hash stability, and CLI exit codes with structured errors.
