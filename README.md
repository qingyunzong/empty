# incremental-sessionizer

Incremental user-session grouper (TypeScript, zero dependencies).

## Semantics

- Events of the same user with consecutive gap `<= gapMs` belong to one session.
- **Out-of-order arrival** may *bridge* (merge) two existing sessions.
- **Retraction** of an event may *split* a session back apart.
- **Watermark**: `advanceWatermark(w)` drops state with
  `ts < w - allowedLatenessMs`; later arrivals in that range are rejected
  (`add` returns no deltas). The watermark never moves backwards.
- Every mutation returns the **session-change deltas** it caused:
  `added` / `updated` / `removed`. Session identity is `userId#start`,
  so a merge appears as `updated` (head session grows) + `removed`
  (absorbed session), and a split as `updated` + `added`.

## API

```ts
import { Sessionizer } from './src/sessionizer';

const s = new Sessionizer({ gapMs: 10, allowedLatenessMs: 20 });
s.add({ userId: 'u1', eventId: 'a', ts: 0 });    // -> [added u1#0]
s.add({ userId: 'u1', eventId: 'c', ts: 20 });   // -> [added u1#20]
s.add({ userId: 'u1', eventId: 'b', ts: 10 });   // bridge: [updated u1#0 -> 0..20x3, removed u1#20]
s.retract('u1', 'b');                            // split:  [updated u1#0 -> 0..0x1, added u1#20]
s.advanceWatermark(100);                         // GC state older than ts 80
s.getSessions();                                 // current materialized sessions
```

`src/reference.ts` provides `referenceSessions(events, gapMs)`, a full-sort
regrouping used to cross-check the incremental engine (see the directed
bridge-then-retract test and the randomized property test).

## Test

```sh
npm test   # tsc compile + node --test
```
