# saga-graph

Executes a dependency graph of steps and, on failure or cancellation,
compensates only the steps that succeeded and define `compensate`, in
reverse dependency order.

## Semantics

- Steps run sequentially in topological (dependency) order; a step is
  skipped if any dependency did not succeed.
- On the first failure, remaining steps are skipped and rollback begins.
- Rollback compensates succeeded, compensable steps in exact reverse
  dependency order. Steps without `compensate` are skipped.
- Compensation failures do not stop the remaining rollback; they are
  collected and exposed on `SagaError.compensationErrors`, and the error
  message states `rollback incomplete` instead of claiming success.
- `saga.cancel()` aborts in-flight steps via `AbortSignal` and triggers
  the same compensation rules; the resulting `SagaError.cause` is a
  `CancelledError`.
- Duplicate ids, unknown dependencies, and cycles are rejected at
  construction time.

## Usage

```ts
import { Saga } from "./src/saga.js";

const saga = new Saga([
  { id: "provision", run: provision, compensate: teardown },
  { id: "migrate", dependsOn: ["provision"], run: migrate, compensate: rollbackMigration },
  { id: "seed", dependsOn: ["migrate"], run: seed }, // not compensable
]);

try {
  await saga.execute();
} catch (err) {
  // err is SagaError with .cause and .compensationErrors
}
```

## Test

```sh
npm test
```

Compiles with `tsc` (TypeScript 7) into `dist/` and runs `node --test`.
