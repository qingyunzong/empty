# event-bus-replay

Offline replay of a production-line event bus (Node.js 22, standard library
only, no dependencies). Merges multi-source device events into a causal
partial order, answers whether an alarm is causally explained by a prior
fault, and detects cyclic sensor configurations (SCCs).

## Layout

- `src/eventbus.js` — library (`EventBus`, error codes, result constants)
- `src/cli.js` — JSONL replay CLI
- `examples/replay.jsonl` — sample op stream
- `test/` — `node --test` suites covering the acceptance criteria

## JSONL op format

One JSON object per line:

```jsonl
{"op":"observe","id":"e1","ts":100,"node":"press-1"}
{"op":"link","a":"e1","b":"e2","kind":"causes"}
{"op":"checkpoint"}
{"op":"rollback","k":2}
{"op":"query","a":"e1","b":"e2"}
{"op":"scc"}
```

Run:

```sh
node src/cli.js examples/replay.jsonl     # from file
node src/cli.js - < examples/replay.jsonl # from stdin
node --test                               # test suite
```

Every input line produces exactly one JSON result line (`line`, `op`,
`ok`, plus `result` / `components` / `layer` / `error` / `message`).
Per-line errors never abort the replay.

## Semantics

- `observe(id, ts, node)` registers an event. Duplicate `id`, empty
  `id`/`node`, or non-finite `ts` -> `INVALID_INPUT`.
- `link(a, b, kind)` adds causal edge `a -> b`. Both endpoints must have
  been observed, otherwise `INVALID_INPUT` ("missing endpoint").
- `query(a, b)` answers from the causal partial order:
  - `REACHABLE` — a path `a ->* b` exists (a causally precedes b).
  - `NOT_REACHABLE` — the reverse is proven (`b ->* a`), so `a` cannot
    reach `b`.
  - `CONCURRENT` — no path either way and `ts(a) === ts(b)`: the same
    physical moment is ordered only by the given partial order; unknown
    order is not treated as a contradiction.
  - `UNDECIDED` — no path either way and timestamps differ. `UNDECIDED`
    is never reported as `NOT_REACHABLE`.
- `scc()` returns strongly connected components of size > 1 (Kosaraju),
  members sorted lexicographically, components sorted by first member.
- `checkpoint()` pushes a layer; `rollback(k)` undoes exactly the most
  recent `k` layers by truncating the op log and rebuilding state.
  - `k < 0` or non-integer -> `INVALID_INPUT`
  - `k > existing layers` -> `ROLLBACK_RANGE`, state left untouched
  - `k = 0` is a no-op

Scale: validated at 4000 events / 3999 links (see scale test).
