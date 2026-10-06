# step-graph-saga

Dependency-aware step graph runner (TypeScript, zero dependencies) with
saga-style compensation.

## Semantics

- Steps declare `dependsOn`; the graph is validated up front (duplicate
  names, unknown dependencies, cycles) and executed sequentially in a
  deterministic topological order (dependencies first, ties broken by
  definition order).
- On step failure **or cancellation** (`AbortSignal`), exactly the steps
  that succeeded AND define `compensate` are rolled back, in reverse
  dependency order. Each `execute`/`compensate` runs at most once.
- Compensation failures are never swallowed: they are aggregated into a
  `CompensationError` (an `AggregateError`) whose `cause` is the original
  failure (or `CancelledError`). Remaining compensations still run.
- A cancellation landing while the final step is in-flight still triggers
  compensation rather than reporting success.

## Usage

```ts
import { runSteps } from "./src/graph.js";

await runSteps(
  [
    { name: "provision", execute: () => createVm(), compensate: (vm) => destroyVm(vm) },
    { name: "configure", dependsOn: ["provision"], execute: () => configure() },
  ],
  { signal: abortController.signal },
);
```

## Test

```sh
npm test   # tsc type-check + compile, then node --test dist/test/*.test.js
```
