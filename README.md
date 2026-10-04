# credit-freeze-hist

Offline decision engine + CLI for whether a broker credit account should be
frozen at a given moment, over append-only JSONL event logs with concurrent
(fork/merge) history. Node.js 22, standard library only, tests via `node:test`.

## Event model

One JSON object per line: `{ts, seq, op, branch?, ...}` — `ts`/`seq` are
non-negative integers, `branch` defaults to `"main"`. Within a branch, events
must be non-decreasing in `(ts, seq)` (`E_TIME` otherwise); ties on the same
`ts` are ordered by `seq`.

State ops:

| op        | fields                              | meaning                                   |
|-----------|-------------------------------------|-------------------------------------------|
| `set`     | `key`, `value`                      | set a risk fact                           |
| `rule`    | `id`, `when:{key,op,value}`, `group?` | risk rule; condition true => freeze     |
| `revoke`  | `id`                                | revoke a rule; affects only later evaluation |
| `group`   | `id`, `parent?`                     | trading group; rules inherit down the chain |
| `account` | `group`                             | place the credit account in a group       |

History ops:

- `fork {name}` — creates branch `name` from the event's branch at this
  position; the new branch sees the parent's events up to the fork point and
  must write strictly after it (`E_FORK` otherwise).
- `merge {name}` — unions the named branch's events visible at the merge
  position into the event's branch. A branch merges at most once.

Rule conditions: `when.op` in `lt|lte|gt|gte|eq|ne`. A rule applies when its
`group` is the account's group or one of its ancestors (inheritance); a rule
without `group` always applies. A missing fact never satisfies a condition.

## Query semantics

`asOf(ts, seq)` on a branch sees exactly the events at positions `<= (ts, seq)`
in the visible union (own branch + fork ancestry + merged branches); later
events are ignored. Revocation only affects evaluation after its position, so
`asOf` before a revoke still sees the rule active.

Conflicts in the merged union resolve **deny-first**: `set` events tied at the
same `(ts, seq, key)` with different values pick the value under which some
rule fires (if any); `revoke` sorts before `rule` at the same position so a
re-defined rule stays active. Remaining ties break by branch name, then log
order — fully deterministic.

## Output

```json
{ "frozen": true, "rule": "R1", "explain": [ /* events */ ] }
```

`explain` is the minimal event set justifying the decision: for a freeze, the
rule definition, the satisfying fact event, and (for group-scoped rules) the
account placement plus the inheritance chain links; for a negative decision
where a condition holds but the rule was revoked, the revoke event; otherwise
empty.

## CLI

```
node cli.js hist.jsonl --as-of 10:3 [--branch B]
```

Prints the decision JSON on stdout. Exit codes: `0` success, `1` on `E_FORK` /
`E_TIME` / `E_PARSE` / `E_IO` (code printed to stderr), `2` on usage errors.

## Library

```js
const { createHistory, query } = require('./lib');
const history = createHistory(fs.readFileSync('hist.jsonl', 'utf8'));
query(history, { ts: 10, seq: 3, branch: 'main' });
```

## Tests

```
node --test
```

- `test/hist.test.js` — seq boundaries, revoke before/after, group inheritance,
  fork/merge deny-first, `E_TIME`/`E_FORK`, explanation minimality.
- `test/random.test.js` — 400 seeded random histories (up to 12 branches)
  cross-checked against an independent reference replay.
- `test/cli.test.js` — CLI behavior driven in-process (the offline sandbox
  forbids child processes); real invocations verified in `RESULTS.md`.
