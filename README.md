# settlement-explorer

Offline settlement state explorer (Node.js 22, standard library only,
`node:test`). Given a plan of two-phase transfers and cancel requests issued
by several actors, it enumerates **every interleaving that preserves each
actor's program order**, checks the safety invariants at every step, and
either proves quota safety with a reproducible certificate or reports the
lexicographically smallest counterexample.

## Usage

```sh
node src/cli.js explore plan.json
```

- Exit `0`: exploration succeeded. Stdout is a JSON report with `reachable`,
  `interleavings`, `violating`, `violatingStates`, and either a
  `counterexample` or a `certificate`.
- Exit `1`: the plan is invalid; stdout is exactly `{"error":"INVALID_PLAN"}`
  (details on stderr).
- Exit `2`: bad usage.

## Plan format

```json
{
  "accounts": [{ "id": "A", "balance": 100 }],
  "actors": [
    { "id": "alice", "steps": [
      { "id": "r1", "type": "reserve", "transfer": "t1", "from": "A", "to": "B", "amount": 60 },
      { "id": "c1", "type": "commit", "transfer": "t1" }
    ]},
    { "id": "dave", "steps": [ { "id": "x1", "type": "cancel", "transfer": "t1" } ] }
  ],
  "freeze": [{ "id": "f1", "account": "A" }]
}
```

The `freeze` array is an ordered freeze plan and becomes an extra actor, so
freeze events interleave with everything else.

Invalid plans are rejected with exit code 1: unknown account/transfer ids,
duplicate account/actor/step/transfer ids, non-positive or non-integer
amounts, and program-order violations inside one actor (commit/cancel before
reserve, or cancel before commit of the same transfer).

## Semantics

State: per-account `balances` and `frozen` amounts, pending-clearing `holds`,
`frozenAccounts`, and a `rejected` log.

- `reserve` freezes the outgoing quota (`frozen += amount`, hold created).
  Rejected when the source account is frozen, the transfer already has a
  hold, or the posted balance is smaller than the amount.
- `commit` posts the transfer (debit source, credit target) and releases the
  hold. Rejected when no hold is pending.
- `cancel` only succeeds before commit; it restores the frozen amount and
  drops the hold. Rejected when no hold is pending.
- `freeze` marks an account; no new `reserve` is accepted from it afterwards.

Business rejections only append a `rejected` record — the ledger never
changes.

## Invariants (checked after every step)

- `CONSERVATION`: the sum of balances equals the initial total.
- `HOLD_EXCEEDS_AVAILABLE`: pending holds (frozen amount) of an account never
  exceed its available balance.
- `NEGATIVE_BALANCE` / `NEGATIVE_FROZEN` / `HOLD_MISMATCH`.

Because `reserve` checks the posted balance without subtracting already
frozen funds, interleavings of concurrent reserves can over-freeze an
account; the explorer finds exactly those and emits the lexicographically
smallest step sequence (compared by step id) that first reaches a violating
state.

## Certificate

When no interleaving violates an invariant, the report contains a
`SAFE_CERTIFICATE` with the plan hash, exploration stats, and
`finalStateHash` — the sha256 of the canonical terminal state (or of the
sorted set of terminal-state hashes when several exist). States are
canonicalized with recursively sorted keys, so the certificate is fully
reproducible for a given plan.

## Tests

```sh
node --test
```

`test/explore.test.mjs` cross-checks the explorer against an independent
enumerator (all permutations filtered by program order) for plans with up to
4 steps. `src/cli.js` exports `run()` so the CLI is tested in-process.
