# limit-lin

Reservation-limit DSL + linearizability checker for concurrent reservation
histories. Node.js 22, standard library only, tests with `node:test`.

## Usage

```
limit check spec.lim history.json --max 8
# or: node bin/limit.js check spec.lim history.json --max 8
```

## Spec DSL

```
account A {
  capacity 100                       // account-level limit
  strategy s1 { quota 60 }           // strategy-level sub-limit
  strategy s2 { quota 40 }           // sum of sub-limits must be <= capacity
  constraint used(s1) + used(s2) <= capacity   // Pratt-parsed expression
  order o1 { strategy s1 amount 30 clock 1 }   // order template + logical clock
}
```

Constraint expressions support `used(s)`, `quota(s)`, `capacity`, integer
literals, `+ - *`, unary `-`, parentheses, and the non-associative
comparisons `< <= > >= == !=`.

## History JSON

```json
{ "ops": [
  { "id": "r1", "kind": "reserve", "account": "A", "strategy": "s1",
    "amount": 30, "invoke": 0, "response": 4, "result": "ok", "clock": 1 },
  { "id": "r2", "kind": "reserve", "order": "o1",
    "invoke": 1, "response": null, "result": "pending" },
  { "id": "c1", "kind": "confirm", "target": "r1", "invoke": 5, "response": 6, "result": "ok" },
  { "id": "x1", "kind": "release", "target": "r1", "invoke": 7, "response": 8, "result": "fail" }
] }
```

Each op has an invoke/response interval. `response: null` means PENDING: the
response is unknown and the op is never treated as a failure; its effects are
considered in every position the precedence constraints allow.

## Semantics

- A history is linearizable iff some sequential order of its operations
  respects real-time order (`response(a) <= invoke(b)` => a before b) and
  logical-clock order (`clock(a) < clock(b)` => a before b), and reproduces
  every observed result under the limit semantics.
- `reserve` succeeds iff account capacity, strategy quota, and all
  constraints hold after adding the amount.
- `confirm`/`release` succeed iff the target reserve is still active;
  statically, each reserve may be confirmed at most once and released at
  most once (E_TYPE otherwise).
- The spec and history compile to bytecode; the VM executes one candidate
  interleaving at a time (never truly concurrent) while the checker
  enumerates the finite interleavings.
- All valid sequential orders are printed in lexicographic order.
- If the history exceeds `--max` operations (or the internal interleaving
  cap), the checker reports E_BOUND instead of guessing.

## Exit codes

| code | meaning   |
|-----:|-----------|
| 0    | OK — linearizable |
| 2    | E_LINEAR — not linearizable |
| 3    | E_PENDING — linearizable, but some responses are unknown |
| 4    | E_BOUND — scale limit exceeded, no verdict |
| 5    | E_TYPE — static typing failed |

## Development

```
node --test
```
