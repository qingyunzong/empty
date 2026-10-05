# statever — finite state-table invariant verifier

Verifies invariants over finite state tables given as JSON, using only the
Go standard library.

**Hard limits (enforced on input):** at most **8 states**, **5 events**,
and a step **budget of at most 10**.

## Input format

```json
{
  "states": ["s0", "s1"],          // <= 8, initial must be one of them
  "initial": "s0",
  "events": ["a", "b"],            // <= 5; array order defines event ID order
  "transitions": [{"from": "s0", "event": "a", "to": "s1"}],
  "bad": ["s1"],                   // states that violate the invariant
  "budget": 10                     // <= 10; defaults to 10
}
```

## Commands

### `sv check [model.json]` — bounded check

Breadth-first search for the **shortest** trace from the initial state to a
bad state, using at most `budget` steps. Ties are broken by **event ID
order** (events are expanded in ID order, so the first violation found is
the lexicographically smallest shortest trace).

If nothing is found, the tool reports only that the invariant **holds
within the bound** — explicitly *not* a global safety proof.

An independent **layered enumeration** (`LayeredEnumerate`, set-based
frontier expansion sharing no code with the BFS) cross-checks the
counterexample length and the budget boundary in the test suite.

### `sv fair [model.json]` — fairness analysis (unbounded)

Searches for the shortest **fair infinite violation**, represented as a
lasso: a reachable **prefix** plus a **cycle** repeated forever. A cycle is
fair iff every event that is **continuously ready** (enabled at every state
of the cycle) **occurs in the cycle**.

Because the state table is finite, the analysis is exact:

- if a fair violation exists, the shortest lasso is returned (prefix +
  cycle, ties by event ID order);
- otherwise the tool returns **complete SCC evidence** (Tarjan
  decomposition with per-SCC bad/fair-cycle/reachability flags) proving
  globally that no fair infinite violation exists.

Every produced lasso is re-checked by an **independent unrolling verifier**
(`VerifyFairLasso`): it re-simulates each step against the table, verifies
loop closure, requires a bad-state visit, and recomputes the
continuously-ready events of the cycle — never trusting the search, and
never treating "no error within the bound" as global safety.

## Development

```sh
go test ./...
go build ./cmd/sv
```
