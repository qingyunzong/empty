# map-limit

Concurrency-limited async `map` for Node.js + TypeScript, using only Node
built-in modules (zero runtime dependencies).

## Semantics

`mapLimit(items, concurrency, mapper, options?)` guarantees:

- **Concurrency limit** — at most `concurrency` mapper calls are in flight.
- **Input-ordered output** — the resolved array matches input order regardless
  of completion order.
- **Fail-fast scheduling** — once any item fails, no later item is started;
  items already in flight are awaited to completion ("started items still
  settle").
- **Earliest failure wins** — if several started items fail (possibly out of
  order), the rejection is a `MapLimitError` carrying the *smallest* failing
  `index`, the original reason as `cause`, and `values`: the successful
  result prefix before that index.
- **Caller abort** — passing an `AbortSignal` cancels all unstarted items;
  in-flight items still settle, then the promise rejects with the abort
  reason (`AbortError` by default). A recorded mapper failure takes
  precedence over the abort reason.

## API

```ts
import { mapLimit, MapLimitError, deferred } from "map-limit";

const values = await mapLimit(urls, 4, async (url, index, signal) => {
  const res = await fetch(url, { signal });
  return res.text();
}, { signal: controller.signal });
```

- `MapLimitError<V>`: `.index` (smallest failing index), `.cause` (original
  rejection), `.values` (successful prefix `results[0..index)`).
- `deferred<T>()`: controllable promise (`{ promise, resolve, reject,
  settled }`) used to orchestrate out-of-order failures in tests.

## Test

Requires Node.js (developed on v22.22.1) and a `tsc` compiler on PATH
(TypeScript 7.0.2 was used). No `npm install` needed — there are no
dependencies; `test/node-shims.d.ts` provides the minimal `node:test` /
`node:assert` typings.

```sh
npm test   # tsc -p tsconfig.json, then runs dist/test/*.test.js
```

### Actual result (2026-10-05, Node v22.22.1, tsc 7.0.2)

```
ok 1 - resolves with values in input order despite out-of-order completion
ok 2 - never exceeds the concurrency limit
ok 3 - stops launching later items after a failure; started items still settle
ok 4 - picks the smallest failing index when failures happen out of order
ok 5 - caller abort cancels unstarted items and lets started ones settle
ok 6 - abort before start launches nothing
ok 7 - rejects invalid concurrency
ok 8 - handles an empty input
ok 9 - surfaces synchronous mapper throws as failures
# tests 9
# pass 9
# fail 0
```
