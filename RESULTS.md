# RESULTS

Environment: Node.js v22.22.1 (`/usr/bin/node`), standard library only, tests via `node:test`.

## Test run

Command: `node --test`

Real output summary (full run, 2026-10-03):

```
# tests 4
# pass 4
# fail 0
# duration_ms 13863.8
```

Per-file breakdown (subtests counted from TAP output of each file):

| File | Subtests | Result | Covers |
| --- | --- | --- | --- |
| `test/limit.test.js` | 10 | pass | A (partial capture + release aggregation), B (ttl boundary, lazy vs scan), D (failed ops don't mutate) |
| `test/linearize.test.js` | 4 | pass | C (checker vs brute-force all permutations of 3 ops, 500 random logs) |
| `test/stress.test.js` | 1 | pass | 20000 mixed ops, invariants hold (frozen >= 0, frozen+used <= limit, frozen == sum of active remaining) |
| `test/cli.test.js` | 3 | pass | `limit run` exit 0, `limit run --explain` E_* lines + exit 1, `limit check` witness / NOT_LINEARIZABLE |

Total: 18 subtests, all passing.

## Acceptance criteria

- **A** `test/limit.test.js`: freeze 100 -> capture 30 -> capture 20 -> release yields
  `{frozen: 0, used: 50}`; capture of full remaining closes the auth; capture beyond
  remaining is `E_LIMIT`.
- **B** Boundary is exactly ttl: an auth frozen at `t0` with `ttl` is valid for
  `t < t0+ttl` and expired at `t == t0+ttl` (capture at `t0+ttl` -> `E_EXPIRED`).
  Lazy expiry (on each op's event time) and periodic `scan(t)` produce identical
  snapshots (asserted via `deepEqual` of full ledger snapshots). Pending auths are
  never failures; `extend` sets `expiresAt = now + ttl`.
- **C** `checkLinearizable(log)` (fast-path identity replay + memoized backtracking)
  compared against brute-force enumeration of all 6 permutations of 3 ops over 500
  randomized logs (both accept- and reject-biased): 0 mismatches; witness sequences
  re-verified by replay.
- **D** After `E_LIMIT` / `E_STATE` / `E_EXPIRED` failures, `frozen`/`used` are
  byte-identical to their pre-op values (validation happens before any mutation).

## CLI

```
node bin/limit.js run ops.jsonl [--explain]   # apply ops; exit 1 if any op fails
node bin/limit.js check log.jsonl             # linearizability check; exit 1 if not linearizable
```

Op format (one JSON object per line):

```
{"op":"open","acc":"alice","creditLimit":1000}
{"op":"freeze","authId":"a1","acc":"alice","amount":100,"ttl":1000,"t":0}
{"op":"capture","authId":"a1","amount":40,"t":10}
{"op":"release","authId":"a1","t":20}
{"op":"extend","authId":"a1","ttl":500,"t":5}
{"op":"scan","t":100}
```

For `check`, each entry additionally carries its recorded `"result"`
(`"ok"` | `"E_LIMIT"` | `"E_STATE"` | `"E_EXPIRED"`). `run` rejects inputs over
20000 operations.

## Environment note

In this sandbox, a grandchild `node` process's piped stdout is swallowed, so
`test/cli.test.js` redirects child output to temp files before asserting. The CLI
itself uses `process.exitCode` (not `process.exit`) to avoid truncating piped
output.
