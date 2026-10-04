# obs-gate

Quality gating for observations before network admission. Single-machine,
offline, Node.js 22, standard library only. New and corrected observations go
through the same auditable decision pipeline; measurement history can be
replayed at any time.

## Quick start

```sh
node bin/gate.js init rules.json          # validate rules, initialize ./.gate/
node bin/gate.js obs observations.jsonl   # ingest observations (JSONL)
node bin/gate.js decide o1                # print decision certificate
node bin/gate.js correct o1 '{"temp_c": 23.1}'   # correction -> same pipeline
node bin/gate.js replay 1700000000000 1700003600000   # full recompute, ISO 8601 also ok
```

State lives in `GATE_DIR` (default `./.gate`): `rules.json`,
`observations.json`, `state.json` (incremental window indexes + cache +
stats), and the append-only audit logs `decisions.jsonl` /
`corrections.jsonl`.

## Rules file

```json
{
  "version": 1,
  "derived": {
    "temp_f": { "add": [ { "mul": [ { "ref": "temp_c" }, { "lit": 1.8 } ] }, { "lit": 32 } ] }
  },
  "rules": [
    { "id": "temp-range", "when": { "cmp": "le", "left": { "ref": "temp_c" }, "right": { "lit": 30 } } },
    { "id": "avg-1h", "when": { "cmp": "lt",
        "left": { "agg": "avg", "window": { "size": 3600000, "bounds": "left-open" }, "expr": { "ref": "temp_c" } },
        "right": { "lit": 28 } } }
  ],
  "exemptions": [
    { "id": "calibration", "priority": 10, "rules": ["temp-range"],
      "match": { "cmp": "eq", "left": { "ref": "site" }, "right": { "lit": "lab-1" } },
      "expiresAt": 1700100000000, "reason": "lab recalibration" }
  ]
}
```

- `derived`: per-observation derived metrics; may reference other derived
  metrics (cycles are rejected with `E_RULE`). Windowed aggregation is not
  allowed inside derived metrics.
- `rules[].when`: boolean expression; `true` pass, `false` fail, `null`
  undecided.
- `exemptions[]`: `priority` (integer, default 0), `rules` (`"*"` or id list,
  default `"*"`), optional `match` expression and `expiresAt`.

## Expression AST

| node | meaning |
| --- | --- |
| `{ "lit": v }` | literal (`null` allowed) |
| `{ "ref": "field" }` | observation field or derived metric; missing -> NULL |
| `{ "add"/"sub"/"mul": [...] }`, `{ "div": [a, b] }` | arithmetic; NULL propagates, `x/0` -> NULL |
| `{ "cmp": "eq|ne|lt|le|gt|ge", "left": e, "right": e }` | comparison; NULL or mixed types -> NULL |
| `{ "and"/"or": [...] }`, `{ "not": e }` | Kleene three-valued logic |
| `{ "isnull": e }` | true iff operand is NULL |
| `{ "agg": "avg|sum|min|max|count", "window": {...}, "expr": e }` | sliding-window aggregate |

Windows are anchored at the decided observation's time `t` with
`start = t - size`. `bounds: "left-open"` (default) covers `(start, t]`;
`bounds: "closed"` covers `[start, t]`. Aggregates ignore NULL values;
`count` of an empty window is `0`, the others are NULL.

## Decisions and three-valued logic

Per rule: `pass` / `fail` / `undecided` (expression NULL) / `exempt`
(fail covered by an exemption). Overall:

- `fail` — any unexempted fail. Counted as a violation, admission denied.
- `undecided` — no fail, at least one undecided. **Blocks automatic
  admission but is not a violation** (`E_UNDECIDED_BLOCK`, exit 3).
- `pass` — everything else (exempt rules included). Admissible.

Exemptions apply only to failing rules whose `match` evaluates to `true`
(NULL does not match) and that are not expired. Among matches the highest
`priority` wins; a tie at the top priority is a conflict and aborts with
`E_EXEMPT`.

## Incremental windows, corrections, replay

For every window definition the engine maintains an incremental index
(time-ordered values + prefix sums) and a cache of computed window results.
`correct <key> <patch>` re-anchors the observation and invalidates **only**
cached windows whose interval contains the old or new timestamp; all other
windows stay valid. `replay <from> <to>` rebuilds every index from the
observation log, drops the cache, and re-decides the range in time order —
incremental results after corrections are identical to a full replay
(verified by the acceptance tests).

## Decision certificate

`decide` / `correct` print a certificate; every decision is also appended to
`decisions.jsonl`:

```json
{
  "certVersion": 1,
  "key": "o1", "time": 1700000000000,
  "decision": "pass", "admissible": true, "violation": false,
  "rulesHash": "…",
  "rules": [{ "id": "avg-1h", "value": true, "outcome": "pass",
              "astHash": "…", "windowKeys": ["w:…:(1699996400000,1700000000000]"],
              "exemptions": [] }],
  "windowKeys": ["…"], "exemptionChain": [],
  "cache": { "hits": 0, "misses": 1 },
  "mode": "incremental", "decidedAt": 1700000000123
}
```

`astHash` is the SHA-256 of the canonical expression AST (key-order
independent), `windowKeys` identify the exact input windows, and
`exemptionChain` records every exemption applied.

## Error codes and exit codes

| code | meaning |
| --- | --- |
| `E_RULE` | invalid rules/expressions (also: gate not initialized) |
| `E_WINDOW` | invalid window definition or replay range |
| `E_EXEMPT` | exemption conflict (priority tie) |
| `E_UNDECIDED_BLOCK` | decision undecided; automatic admission blocked |
| `E_OBS` | invalid/duplicate/unknown observation |

Exit codes: `0` pass/success, `1` error, `2` decision fail, `3` decision
undecided.

## Tests

```sh
node --test
```
