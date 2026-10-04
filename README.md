# faircheck

A small model checker CLI (Go standard library only) for finite state
tables: bounded invariant checking with an independently verified shortest
counterexample, plus explicit-fairness liveness checking with lasso
counterexamples or complete SCC evidence.

## Input

JSON on stdin (or `-file`), validated against hard limits:
**at most 8 states, at most 5 events, step budget at most 10**.

```json
{
  "states": ["s0", "s1", "g"],
  "initial": "s0",
  "events": ["a", "b"],
  "transitions": [{"from": "s0", "event": "a", "to": "s1"}],
  "bad": ["s1"],
  "goal": ["g"],
  "budget": 10
}
```

- `bad` — safety invariant: bad states are unreachable.
- `goal` — liveness property: goal states are visited infinitely often.
- `budget` — optional (flag `-budget` overrides), default 10, max 10.
- Event ID order is the order of `events`; it breaks all ties.
- Nondeterminism is allowed (same state+event may have several targets).

## What it computes

1. **Bounded safety** — BFS up to `budget` steps for the shortest trace
   into a bad state; among shortest traces the lexicographically smallest
   by event ID wins. If none is found it reports only
   *"holds within budget"* — never global safety.
2. **Exact safety** — the state table is finite, so full reachability
   decides the invariant exactly; a bounded miss is never reported as
   global safety.
3. **Fairness** — infinite counterexamples are lassos: a reachable prefix
   plus a cycle in goal-free states such that every *continuously enabled*
   event (enabled at every state of the cycle) occurs in the cycle. The
   tool returns the shortest fair lasso (minimizing prefix+cycle length,
   then prefix length, then event ID order), or **complete SCC evidence**:
   every SCC of the reachable goal-free subgraph with the reason it cannot
   host a fair cycle (trivial, or a witness event that is continuously
   enabled but never fired inside).

## Independent verification

Every claim is re-checked by `package verify`, which shares no search code
with `package checker`:

- **Layered enumeration** — iterative-deepening enumeration of all event
  sequences (subset construction) independently confirms the
  counterexample length and the budget boundary.
- **Lasso unrolling** — the reported prefix+cycle is unrolled (x3) and
  replayed against the raw table: steps valid, cycle goal-free, fairness
  condition holds on one period.
- **SCC evidence** — recomputed via mutual reachability (not Tarjan);
  coverage, maximality, and every witness claim are validated.

## Usage

```
go build -o faircheck .
./faircheck -file examples/fair_lasso.json
./faircheck -json -budget 4 < examples/bounded_miss.json
go test ./...
```

## Test results

`go test ./...` (Go 1.27.1, linux/amd64), including exhaustive
cross-checks over all 4096 deterministic 3-state/2-event tables x all
bad/goal subsets x budgets 0..4:

```
ok  	faircheck
ok  	faircheck/checker
ok  	faircheck/verify
```
