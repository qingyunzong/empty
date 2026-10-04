# versioned-subscriptions

Versioned snapshot/delta subscription library in TypeScript, using only
Node.js built-in modules (`node:test`, `node:assert`, `structuredClone`,
timers). No runtime dependencies.

## Guarantees

1. **Snapshot first.** The first message a subscriber receives is a
   versioned snapshot (`{ type: "snapshot", version, state }`). The snapshot
   is captured synchronously at subscribe time and delivered via a promise
   (optionally delayed via `snapshotDelayMs` to simulate slow serialization).
2. **In-flight deltas are appended after the snapshot, consecutively.**
   Deltas published while the snapshot promise is pending are replayed from
   the store's shared delta log as `snapshot.version + 1, + 2, ...`.
3. **Explicit resync on overflow, never silent version skips.**
   - Per-subscription buffer overflow (slow consumer, `maxBuffer` exceeded),
   - or the shared log (`maxLog`) trimmed past a lagging subscriber,

   both produce an explicit `{ type: "resync", version, state }` message (a
   fresh snapshot). The stream then continues consecutively from
   `resync.version + 1`.
4. **Close never resurrects.** `close()` interleaved with an in-flight
   snapshot promise emits nothing and keeps the subscription unregistered;
   the returned promise settles only after the in-flight snapshot has
   settled, so no late resolution can revive the subscription.
5. **Reentrant updates stay ordered.** Updates triggered from update
   listeners or from within message consumption receive later, consecutive
   versions and are delivered in version order.

## Usage

```ts
import { VersionedStore } from "./src/index.js";

const store = new VersionedStore<{ count: number }, { by: number }>(
  { count: 0 },
  { maxLog: 1024, snapshotDelayMs: 0 },
);

const sub = store.subscribe({ maxBuffer: 256 });

store.update((s) => { s.count += 1; return { by: 1 }; }); // -> version 1

for await (const msg of sub) {
  // msg: snapshot | delta | resync, always gap-free per the rules above
}

await sub.close();
```

## Test

```
npm test    # tsc -p tsconfig.json && node --test "dist/test/*.test.js"
```

## Actual test results

Recorded on Node.js v22.22.1, tsc 7.0.2 (repeated runs, stable):

```
ok 1 - snapshot is sent first; deltas arriving during the snapshot are appended after it, consecutive
ok 2 - buffer overflow triggers explicit resync instead of silently skipping versions
ok 3 - shared log trimmed past a starting subscriber forces explicit resync
ok 4 - close interleaved with snapshot resolution never resurrects the subscription
ok 5 - close before a zero-delay snapshot resolves emits nothing
ok 6 - reentrant updates keep versions consecutive and in order
ok 7 - slow consumer receives every delta, consecutive and in order
ok 8 - subscribers are independent: a slow peer does not affect a fast one
# tests 8
# pass 8
# fail 0
```

`npm test` summary output:

```
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

(The file-level rollup counts the test file as one entry; the 8 subtests
above are the individual acceptance cases.)

## Layout

- `src/index.ts` — `VersionedStore` + `Subscription` implementation.
- `src/node-shims.d.ts` — minimal ambient types for the Node built-ins used
  (the offline environment has no `@types/node`).
- `test/subscription.test.ts` — acceptance tests: snapshot ordering,
  overflow resync (per-subscription buffer and shared-log trim), close /
  snapshot-promise race (50 randomized interleavings), reentrant updates,
  slow consumers, subscriber independence.
