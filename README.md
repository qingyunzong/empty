# trade-lin-checker

Linearizability checker for concurrent trading-reservation histories, built on
the Node.js 22 standard library and `node:test` (no dependencies).

Given a history of `reserve` / `commit` / `cancel` / `read` operations from
concurrent clients, it decides whether there exists a sequential order —
with every linearization point inside its operation's
`[invocationTime, responseTime]` interval and respecting real-time order —
that reproduces every recorded response.

## Usage

```sh
node cli.js check history.json --initial alice=1000 --initial bob=250
node --test          # run the test suite
```

Output (exit code 0, well-formed history):

```json
{ "linearizable": true, "witness": ["read-old", "res1", "read-new"], "linearizationPoints": [1, 5, 5] }
```

or

```json
{ "linearizable": false, "conflict": "no valid linearization; deepest contradiction: ..." }
```

Exit codes:

- `0` — history is well-formed; the JSON verdict is on stdout (both
  `linearizable: true` and `linearizable: false`).
- `1` — `INVALID_HISTORY`: malformed JSON, non-array top level, missing or
  mistyped fields, inverted time intervals (`invocationTime > responseTime`),
  negative amounts, duplicate `opId`s, etc. Error JSON on stderr.
- `2` — usage error.

## History format

A JSON array of operations:

```json
{
  "client": "c1", "opId": "res1",
  "invocationTime": 0, "responseTime": 10,
  "type": "reserve", "account": "alice",
  "amount": 100, "reserveId": "r1",
  "ok": true
}
```

- `amount`: required for `reserve` (number >= 0); absent/`null` otherwise.
- `reserveId`: required for `reserve`/`commit`/`cancel`; absent/`null` for `read`.
- `result`: required for `read`, `{"balance": N, "frozen": N}`; absent/`null` otherwise.
- `ok`: boolean, the recorded success/failure of the operation.
- Accounts start at balance 0 unless given via `--initial account=balance`
  (CLI) or `checkLinearizable(ops, { initial })` (API).

## Semantics (all edge cases defined)

- `reserve` succeeds iff `reserveId` is unused and `balance >= amount`;
  moves `amount` from `balance` to `frozen` and opens the reservation.
- **Zero amount**: a zero `reserve` always succeeds, holds nothing, and the
  reservation can later be committed or cancelled like any other.
- `commit` succeeds exactly once, only on an open reservation; it consumes
  the held funds (`frozen -= amount`). A later `commit` or `cancel` on the
  same `reserveId` fails.
- `cancel` succeeds only on an open reservation; it returns the held funds
  (`frozen -= amount`, `balance += amount`).
- **Unknown `reserveId`**: `commit`/`cancel` fail. A history recording
  `ok: true` for them is well-formed but not linearizable.
- **Duplicate responses** (two entries with the same `opId`) are rejected as
  `INVALID_HISTORY` (exit 1).
- `read` always succeeds and must observe the exact `{balance, frozen}` of
  some legal linearization point; overlapping reads may observe old or new
  values.

## Architecture

- `src/model.js` — sequential state machine (single source of truth for semantics).
- `src/validate.js` — structural validation, throws `INVALID_HISTORY`.
- `src/checker.js` — memoized backtracking search over real-time-minimal ops;
  produces a witness order plus linearization points, or the deepest
  contradiction as the conflict reason.
- `src/enumerator.js` — independent brute-force `n!` permutation enumerator
  (own simulator, shared no code with the checker) used to cross-check the
  main checker on histories of <= 6 operations.
- `cli.js` — `check` command.
- `test/` — `node:test` suites, including randomized and exhaustive
  checker-vs-enumerator agreement tests.
