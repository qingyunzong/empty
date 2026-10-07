# logical-time-scheduler

A deterministic logical-time scheduler for tests, written in TypeScript.

## Semantics

- **Due-only I/O**: `advanceTo(target)` / `advanceBy(dt)` deliver only I/O
  events whose deadline is `<= target`; future events stay pending.
- **Id-ordered microtasks**: microtasks drain in registration-id order after
  each I/O delivery and at the end of a tick.
- **Tail append at equal times**: events are ordered by `(time, id)` with
  monotonically increasing ids, so events registered for the same logical
  time — including reentrant registrations from inside a handler — go to the
  tail of that slot.
- **Budgeted, resumable ticks**: `new Scheduler({ budget: n })` caps
  deliveries per call. When the budget runs out mid-tick the clock stops at
  the last delivered event, the report has `exhausted: true`, and `resume()`
  continues the same tick with a fresh budget.
- **Time + delivery trace**: every delivery/cancellation is recorded in
  `trace()` with its logical time; each advance/resume returns a
  `TickReport { target, now, exhausted, delivered }`.
- **No backward clock**: advancing to a past time (or scheduling in the past)
  throws `ClockBackwardError`.
- **Cancellation & reentrancy**: handles support idempotent `cancel()`;
  handlers may reentrantly schedule and cancel, but reentrant
  `advanceTo`/`advanceBy` throws `ReentrantAdvanceError`.

## Usage

```ts
import { Scheduler } from './src/index.js';

const s = new Scheduler({ budget: 2 });
s.scheduleAt(5, 'fetch', () => console.log('fetched at', s.now()));
s.queueMicrotask('log', () => {});
const report = s.advanceTo(10);
if (report.exhausted) s.resume();
console.log(s.trace()); // [{ seq, time, id, kind, label, action }, ...]
```

## Test

```sh
npm test   # tsc -p tsconfig.json && node dist/test/scheduler.test.js
```

Tests use `node:test` and include a list-based reference model that
cross-checks the scheduler's delivery trace for cancellation and reentrancy.
