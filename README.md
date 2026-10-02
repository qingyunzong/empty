# payfuzz

Deterministic payment-limit fuzzing library and CLI (Node.js 22, stdlib only).

- `src/prng.js` — deterministic mulberry32 PRNG (no `Math.random`, no `Date`; enforced by tests).
- `src/ledger.js` — reserve / settle / cancel state machine. Rejections
  (`insufficient_funds`, `account_frozen`, `hold_not_open`, `hold_not_found`)
  never mutate state.
- `src/fuzz.js` — seeded run generator; logs seed, per-op sequence number,
  random integer samples, operation id, and result for every step.
- `src/replay.js` — regenerates a run from `(seed, steps, accounts)` and
  verifies random samples, op results, final state, and state hash.
- `src/enumerator.js` — independent reference model; enumerates all
  interleavings of plans with ≤ 4 steps to cross-check the engine.
- `src/cli.js` — command line interface.

## Usage

```sh
node src/cli.js fuzz --seed 42 --steps 80 --accounts 3 --out run.json
node src/cli.js replay run.json
```

`replay` exits 0 only if the regenerated run matches the file on random
sample sequence, op results, final state, and state hash. Invalid input
(bad seed, negative steps, unknown op type, …) exits 1 with
`{"error":"INVALID_INPUT", ...}` on stderr.

## Tests

```sh
node --test
```
