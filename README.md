# exp-planner

Reproducible experiment task planning library and CLI. Offline, Node.js 22, standard library only (`node:test` for tests).

## Spec format

```json
{
  "name": "demo",
  "budget": 20,
  "target": { "artifact": "score", "type": "metric" },
  "tasks": [
    { "name": "fetch", "cost": 10, "produces": [{ "name": "raw", "type": "file" }] },
    { "name": "synth", "cost": 10, "produces": [{ "name": "raw2", "type": "dataset" }] },
    { "name": "evaluate", "cost": 10, "requires": "fetch | synth", "produces": [{ "name": "score", "type": "metric" }] }
  ]
}
```

- `requires` is a boolean expression over task names: `&` (and), `|` (or), `!` (not), parentheses. Precedence: `!` > `&` > `|`; `&` and `|` are left-associative. Parsed with a Pratt parser (`src/parser.js`).
- Artifact types are exactly `file`, `dataset`, `metric`.
- Static checks (`src/validate.js`): field types, unique task/artifact names, every task reference in `requires` must exist, the target artifact must be produced by some task, and the declared target type must match the produced type.

## Planning semantics

A task set is feasible when it is closed under dependencies (every member's `requires` evaluates to true over the set), its total cost is within `budget`, and the target artifact is produced by some member. The planner (`src/planner.js`) enumerates all subsets deterministically and returns every optimum: maximum cardinality first, then minimum cost. Sets tied on both are all returned, sorted lexicographically by task-name sequence — never an arbitrary pick. If no feasible set exists, planning fails with `E_NO_FEASIBLE_SET` and no partial plan is emitted. Exhaustive enumeration supports up to 30 tasks.

## CLI

```sh
node src/cli.js create spec.json --state planner.state.json   # -> {"version": 1, ...}
node src/cli.js plan --state planner.state.json               # -> plans + certificate + version
node src/cli.js revise fetch 4 --state planner.state.json     # -> {"version": 2, ...}; version 1 retained
node src/cli.js plan --version 1 --state planner.state.json   # old versions stay plannable
node src/cli.js versions --state planner.state.json
```

`plan` prints `{ version, budget, target, plans, certificate }`. The certificate is `sha256:` of the canonical JSON (recursively key-sorted) of `{ version, spec, plans }`, so identical inputs always yield identical certificates. Errors exit with status 1 and a structured `{"error": {code, message}}` on stderr; nothing is written to stdout and no state file is created or modified on failure.

## Library

```js
import { ProjectStore } from './src/project.js';
const store = new ProjectStore();
store.create(spec);            // -> 1
store.revise('fetch', 4);      // -> 2 (version 1 kept)
store.plan(2);                 // -> { version, budget, target, plans, certificate }
```

## Tests

```sh
node --test
```
