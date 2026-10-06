# proto-equiv

Protocol-testing CLI that compares two deterministic automata (at most 30
states each) over a shared ordered alphabet, with integer outputs and 8-bit
register updates on transitions.

## Usage

```sh
npm run build
node dist/src/main.js <spec.json> [--budget N] [--enum-words N] [--cert-limit N]
```

Exit codes:

| code | meaning                                        |
|------|------------------------------------------------|
| 0    | automata are equivalent (certificate printed)  |
| 1    | not equivalent (shortest distinguishing word)  |
| 2    | unknown: state budget exhausted                |
| 3    | usage / input error                            |

## Semantics

- **Alphabet is ordered.** Symbols are deduplicated and sorted; this order
  defines lexicographic order on words.
- **Missing edges** fall into an implicit *rejecting sink*: it loops on every
  symbol, is never accepting, emits no output (`null`) and keeps registers.
- **Transitions carry integer outputs.** `output` may be an integer constant,
  an expression string over registers (e.g. `"seq * 2 + 1"`, evaluated on the
  pre-transition registers and masked to 8 bits), or `null` (no output).
  Outputs are part of the observable behaviour: `0` differs from `null`.
- **Register updates** (`update`) are expression strings evaluated
  simultaneously against the pre-transition registers; results are masked to
  unsigned 8 bits. Expression grammar: `+ - * / %`, parentheses, unary `-`,
  integer literals, register names. Division truncates toward zero.
- **Equivalence** is checked by BFS over the reachable product configuration
  space `(state1, state2, registers1, registers2)` — all reachable 8-bit
  register states are compared. A divergence is either an *acceptance
  mismatch* (same word, different acceptance) or an *output mismatch* (same
  word, different emitted output on the next symbol).
- The reported distinguishing word is **shortest**, ties broken
  **lexicographically** (ordered alphabet + FIFO BFS).
- **State budget**: if the number of explored product configurations reaches
  the budget (`stateBudget` in the spec, or `--budget`), the checker stops
  and reports `UNKNOWN` — it never claims equivalence in that case.
- **Certificate**: on equivalence, the reachable product configurations are
  printed (limited by `--cert-limit`, default 50). As a cross-check, all
  words up to a derived length (bounded by `--enum-words`, default 250000)
  are enumerated and both machines are simulated step by step.

## Spec format

```json
{
  "alphabet": ["a", "b"],
  "registers": ["seq"],
  "initialRegisters": { "seq": 0 },
  "stateBudget": 200000,
  "automata": [
    {
      "name": "A",
      "states": ["q0", "q1"],
      "initial": "q0",
      "accepting": ["q1"],
      "transitions": [
        { "from": "q0", "on": "a", "to": "q1", "output": 1, "update": { "seq": "seq + 1" } }
      ]
    },
    { "name": "B", "states": ["p0"], "initial": "p0", "transitions": [] }
  ]
}
```

Validation enforces: exactly two automata, at most 30 states each,
determinism (no duplicate `(from, on)` transitions), known states/symbols,
integer outputs, and known registers in updates/outputs.

See `examples/` for ready-to-run specs.

## Tests

```sh
npm test
```

Builds the TypeScript sources and runs the `node:test` suites in `test/`
(expression evaluator, spec validation, equivalence engine, CLI end-to-end).
