# clearing-settle

Payment clearing-house settlement over event time: 5-minute tumbling windows of
merchant net amounts, with watermark-based lateness handling, risk voids, and
verifiable certificates. Node.js 22 standard library only.

## Usage

```
node cli.js settle --in events.jsonl --wm 3000 --out out.jsonl [--naive]
```

- Input: JSONL events `{type: auth|capture|void, id, mch, amt, ts}` (`amt` in
  integer cents; `void` only needs `id` + `ts`).
- `--wm`: allowed lateness in ms. Watermark = maxTsSeen - wm; a window closes
  when the watermark passes its end. Events with `ts < watermark` are recorded
  as `late` and never settled.
- `--naive`: re-runs an independent full-replay engine (intended for <=200
  events) and exits 3 if its output differs from the streaming engine.

## Output

One JSON record per line. Settled windows:

```json
{"winStart":0,"winEnd":300000,"mch":"mA","net":500,"cert":"<sha256>","status":"final"}
```

`cert = sha256(JSON({v: RULES_VERSION, kind, winStart, winEnd, mch, entries}))`
where `entries` are the canonical (arrival-order-independent) contributing
entries, so anyone can recompute it from the raw input. `RULES_VERSION` is
`settle-v1` (`lib/common.js`).

Other record kinds:

- `status:"correction"` — a `void` arrived after the window closed; history is
  never rewritten, a negative correction is emitted instead.
- `status:"late"` — event beyond the watermark, not settled.
- `status:"error", code:"CONFLICT"` — duplicate `id` capture/auth (counted once).
- `status:"error", code:"DATA_ERROR"` — non-integer/negative `amt`, bad shape.
- `status:"error", code:"UNKNOWN_VOID"` — void with no matching active entry.

Exit codes: `0` ok, `1` usage/IO error, `2` invalid JSON (line number on
stderr), `3` naive replay mismatch.

## Layout

- `cli.js` — argument parsing, JSONL reading, exit codes.
- `lib/common.js` — window math, validation, canonical certs.
- `lib/settle.js` — streaming engine (incremental per-window state).
- `lib/naive.js` — independent full-replay engine for `--naive` cross-checks.
- `test/settle.test.js` — `node --test` suite covering acceptance A–D.
