# repro-planner

Reproducible experiment task planning library and CLI. Single-machine, fully
offline, Node.js 22+, standard library only (`node:test` for tests).

## Spec format

```json
{
  "budget": 6,
  "targets": ["report.out"],
  "tasks": [
    { "name": "t1", "cost": 2, "produces": [{ "name": "raw.data", "type": "dataset" }] },
    { "name": "t3", "cost": 2, "produces": [{ "name": "report.out", "type": "file" }],
      "requires": "dataset:raw.data & !metric:loss" }
  ]
}
```

- `requires` is a boolean expression over artifact names, parsed by a Pratt
  parser. Operators: `!` (tightest), `&`, `|` (loosest), plus parentheses.
- A reference may carry a type qualifier (`file:x`, `dataset:x`, `metric:x`)
  which is statically checked against the producer's declared type.
- Artifact types are restricted to `file`, `dataset`, `metric`.

## Static checks (all-or-nothing, no half plans)

- Field types: names non-empty strings, costs finite numbers `>= 0`, etc.
- Artifact types must be one of `file | dataset | metric`.
- Every referenced artifact must be produced by some task.
- A type qualifier must match the producer's declared type.
- Targets must be producible; duplicate task names and conflicting artifact
  types are rejected.

## Planner semantics

Exhaustive enumeration over task subsets (guard: at most 24 tasks). A set is
feasible when it is dependency-closed, its total cost is within `budget`, and
all `targets` are produced. Optimal sets are those of maximum cardinality and,
among those, minimum cost. **All** sets tied on `(size, cost)` are returned,
sorted lexicographically by their sorted task-name sequence — nothing is
chosen arbitrarily. If no feasible set exists, an `E_NO_FEASIBLE` error is
raised and nothing is emitted.

## Versioning

`PlannerStore` keeps immutable versions. `revise(version, taskName, newCost)`
commits a new version with one task's cost changed; the old version is
preserved. A failed validation never mutates the store.

## Certificate

Each plan is accompanied by a normalized certificate: a canonical JSON
serialization (sorted object keys) of the plan plus its version, and its
SHA-256 digest, making runs comparable and reproducible.

## CLI

```
node cli.js plan <spec.json> [--store planner-store.json]
node cli.js revise <store.json> --version N --task NAME --cost X
node cli.js show <store.json> [--version N]
```

Success prints `{ ok, version, plan, certificate }` on stdout. Any error
prints `{ ok: false, error: { code, message } }` on stderr, exits non-zero,
and persists nothing.

## Library

```js
import { PlannerStore, plan, makeCertificate } from './src/index.js';

const store = new PlannerStore();
const v1 = store.addVersion(spec);
const result = plan(store.getRawSpec(v1));
const cert = makeCertificate(result, v1);
const v2 = store.revise(v1, 't1', 5); // old version kept
```

## Tests

```
node --test
```

Last recorded run (2026-10-03, Node v22.22.1): **4 files, 4/4 passed**
(`test/expr.test.js`, `test/planner.test.js`, `test/store.test.js`,
`test/cli.test.js`), covering the three acceptance criteria:

1. The fixture graph in `examples/spec.json` returns exactly the two
   hand-enumerated tied-optimal sets `["t1","t2","t3"]` and `["t1","t2","t4"]`
   (size 3, cost 6).
2. Lowering the budget to 3 raises `E_NO_FEASIBLE` and persists nothing.
3. Writing a `file` dependency as `metric:report.out` fails statically with
   `E_TYPE_MISMATCH` and the store's version count is unchanged.
