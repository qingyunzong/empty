# gate — observation quality gating

Quality gating for observations before network admission. Single-machine,
offline, Node.js 22, standard library only. New observations and corrections
go through the same auditable decision path; measurement history can be
replayed from an append-only event log.

## Install / run

```sh
node bin/gate.js <command> ...        # or: npm link, then `gate ...`
npm test                              # node --test
```

State lives in `$GATE_HOME` (default `./.gate`):

- `rules.json` — validated, normalized rules config (with AST hashes)
- `events.jsonl` — append-only log of `obs` / `correct` events (replay source)
- `state.json` — materialized state: observations + incremental window caches

## Commands

| command | description |
|---|---|
| `gate init <rules.json> [--force]` | validate config, initialize gate home |
| `gate obs <file.jsonl>` | ingest observations, one JSON object per line |
| `gate correct <key> <patch>` | apply `{"ts":..., "metrics":{...}}` to an observation |
| `gate decide <key>` | evaluate all rules, print the decision certificate |
| `gate replay <from> <to>` | rebuild from the event log, re-decide `from <= ts <= to`, check consistency with the incremental state |

Observation: `{"key": "o1", "ts": 10000, "metrics": {"temp": 80}}`.

## Rules config

```json
{
  "derived": { "ratio": "a / b" },
  "windows": { "w1m": { "size": 60000, "hop": 10000, "bounds": "(]" } },
  "rules": [
    { "id": "temp_max", "expr": "temp <= 100" },
    { "id": "avg_temp", "expr": "avg(temp) over w1m <= 90" }
  ],
  "exemptions": [
    { "id": "maint", "priority": 10, "rules": ["temp_max"],
      "when": "site == 'A'", "from": 0, "until": 25000 }
  ]
}
```

- `derived`: per-observation metrics computed in order before rule evaluation
  (no aggregates allowed).
- `windows`: `size` (window length), `hop` (bucket granularity for incremental
  state, must divide `size`; default = `size`), `bounds` — one of `[)`, `(]`,
  `[]`, `()` (default `(]`). A window evaluated at time `T` covers the
  interval from `T - size` to `T` with the given open/closed ends.
- `rules`: boolean expressions; see expression language below.
- `exemptions`: `rules` (`["*"]` or rule ids), optional `when` expression,
  optional `from`/`until` ts range, `priority` (default 0).

## Expression language

- literals: numbers, `'strings'`, `true`, `false`, `null`
- identifiers: observation metrics, `key`, `ts`, derived metrics
  (unknown identifier → `NULL`)
- arithmetic: `+ - * / %`, unary `-`
- comparison: `== != < <= > >=`, plus `x is null` / `x is not null`
- logic: `and`, `or`, `not` (three-valued)
- aggregates: `avg(expr) over w`, `sum`, `min`, `max`, `count`

NULL is three-valued: any comparison or arithmetic involving NULL yields NULL;
`null and false` is `false`, `null or true` is `true`, `not null` is NULL.
Aggregates skip NULL/non-numeric values; over an empty window `count` is `0`
and the others are NULL. Division by zero yields NULL.

## Decisions

Each rule evaluates to `true` / `false` / `null` (unknown):

- **fail** — at least one rule is `false` and not exempted (a violation)
- **undecided** — no violations, but at least one rule is unknown; automatic
  admission is blocked (`E_UNDECIDED_BLOCK`) but it is **not** a violation
- **pass** — everything else

A failed rule is exempted when a matching exemption exists. If several match,
the highest `priority` wins; a tie at the top priority is an `E_EXEMPT`
error. The decision certificate records, per decision: rule results with
per-rule expression AST hashes, the config `rulesHash`, the concrete input
window keys consulted, and the full exemption chain (winner + contenders).

## Incremental windows and corrections

Window aggregates are maintained as bucketed partial aggregates
(`sum/count/min/max` per `hop`-sized bucket) plus a per-window-instance query
cache. Ingesting or correcting an observation at time `t` invalidates exactly
the bucket containing `t` and the cached window instances whose interval
contains `t` — nothing else. `gate replay` rebuilds everything from the event
log and verifies that the incremental state produces identical certificates.

## Errors and exit codes

| code | exit | meaning |
|---|---|---|
| — | 0 | ok / decision pass |
| — | 1 | decision fail (violation), or replay inconsistency |
| `E_RULE` | 2 | invalid rules config or expression |
| `E_WINDOW` | 3 | invalid window definition or reference |
| `E_UNDECIDED_BLOCK` | 4 | decision undecided; automatic admission blocked |
| `E_EXEMPT` | 5 | exemption conflict (priority tie) or invalid exemption |
| `E_INPUT` | 6 | bad input (unknown key, duplicate key, bad patch, ...) |
| — | 64 | usage error |

Errors are printed to stderr as `{"error":{"code":...,"message":...}}`;
certificates and command results go to stdout as JSON.
