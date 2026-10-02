# plan-sync

Offline schedule replication for factory floor terminals. A master plan is
dispatched to offline workstations as a seed; each terminal edits its schedule
locally (insert / move / cancel operations); terminals later converge
bidirectionally. Node.js 22 standard library only, no dependencies.

## Data model

Each replica directory holds:

| file | role |
| --- | --- |
| `seed.json` | base plan dispatched to every terminal: `{jobs:[{id,due,weight}], ops:[{id,job,machine,start,dur,preds,machines]}]}` |
| `constraints.json` | optional `{budget}` — max total weighted tardiness |
| `log.jsonl` | JSONL change log, one canonical-JSON change per line |
| `snapshot.json` | materialized state cache `{baseHash,logHash,clock,logLen,changes}` |
| `manifest.json` | commit record `{snapshotLogLen,snapshotHash,clock}` |
| `identity.json` | stable node id of the replica |

A change is `{changeId,node,clock,type,op}` with `type` in
`insert|move|cancel`; `clock` is a vector clock. `changeId` is `node:counter`.

## Constraints (validated on `apply`, checked by `verify`)

- precedence: `pred` end ≤ op start, acyclic, preds must exist
- capability: assigned machine ∈ op `machines`
- no overlap per machine
- due-date penalty budget: `Σ weight·max(0, end−due) ≤ budget`

## Merge rules (deterministic)

Changes are ordered by happened-before (vector clocks), ties by `changeId`.
Concurrent changes on the same operation conflict and resolve as:

1. any concurrent `cancel` wins (`cancel-wins`)
2. concurrent `insert`s of the same id: smallest `changeId` wins (`insert-first`)
3. concurrent `move`s: lowest resulting plan cost wins, ties by smallest
   `changeId` (`min-cost-then-changeId`)

Losers and changes that would violate constraints enter `pending`. Pending
items are **not** treated as unsatisfiable: the plan is still materialized
without them and `verify`/`sync` report them with exit code 3.

## CLI

```
plan-sync apply  --dir D [--node N] --type insert|move|cancel --data '<json>'
plan-sync sync   --dir A --peer B
plan-sync resume --dir D
plan-sync verify --dir D
plan-sync export-cert --dir D [--out file]
```

Stdout is a JSON result; errors are JSON on stderr. Exit codes:

| code | meaning |
| --- | --- |
| 0 | ok |
| 2 | validation failure |
| 3 | unresolved conflict pending |
| 4 | recovery failure |
| 70 | injected crash (fault injection) |

## Fault injection & recovery

Set `PLAN_SYNC_FAIL_AT` to simulate a power-loss crash at a defined point:

| point | crash site | `resume` behaviour |
| --- | --- | --- |
| `before-append` | before the log append | recovers to the last consistent point; change absent |
| `after-append` | after append, before fsync (torn tail) | truncates the torn tail, replays the durable log |
| `before-rename` | after snapshot temp write, before rename | discards the half snapshot, replays log past the old snapshot |
| `after-manifest` | after manifest commit | reports the committed state (`committed.logLen/clock`) from the manifest |

`resume` repairs the replica (truncates torn log tail, deletes stale temp
files, re-snapshots) and prints a JSON recovery report.

## Certificates

`export-cert` emits a deterministic certificate (base/log/plan hashes, vector
clock, cost, conflict decisions with contender costs, pending list). After
`sync`, both replicas produce byte-identical certificates; concurrent moves of
the same operation therefore yield a reproducible certificate.

## Exact optimizer

`src/optimize.js` exports `optimize(plan)` — exhaustive search over machine
assignments × topological orders returning the minimum weighted tardiness and
an optimal schedule. The test suite cross-checks it against an independent
brute-force enumeration for n ≤ 8 operations.

## Tests

```
node --test
```
