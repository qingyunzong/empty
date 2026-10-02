# tank-scheduler

Offline batch-tank scheduling library and CLI. Pure Node.js 22 standard
library, no dependencies. Tasks are assigned to mixing tanks via a
finite-domain CSP: tank id and start time are the domains; capacity,
material compatibility and cleaning-time bounds are propagated; task
ordering is resolved by backtracking with a node budget.

## Input format

```json
{
  "horizon": 24,
  "budget": 100000,
  "defaultCleaningTime": 0,
  "tanks": [{ "id": "T1", "capacity": 100, "materials": ["A", "B"] }],
  "cleaning": [{ "from": "A", "to": "B", "time": 2 }],
  "tasks": [{
    "id": "J1", "material": "A",
    "minCapacity": 40, "maxCapacity": 120,
    "duration": 3, "earliestStart": 0, "deadline": 24,
    "locked": false, "tank": "T1", "start": 4
  }]
}
```

- `locked: true` fixes `start` (required) and optionally `tank`; locked
  tasks are never moved and are never removed during conflict minimization.
- `cleaning` rules give the wash time required when a task of material
  `from` is followed by a task of material `to` on the same tank; equal
  materials need no cleaning, missing pairs use `defaultCleaningTime`.
- `horizon`/`deadline` are optional; an open horizon is derived from the
  sum of durations plus cleaning slack.

## Library

```js
import { solveWithConflict, verifyAssignment } from './src/solver.js';
const result = solveWithConflict(input, { budget: 10000 });
// { status: 'feasible', assignment: { J1: { tank, start, end } } }
// { status: 'infeasible', conflict: { tasks, holds, tanks, cleaningRules } }
// { status: 'unknown', pending: [...] }   <- budget exhausted
```

The conflict is minimized by deletion (only unlocked, non-hold tasks are
removable) and references the involved tanks, tasks, holds and cleaning
rules.

## CLI

```
node cli.js assign input.json [--budget N]
node cli.js hold input.json --tank T1 --start 0 --duration 8 [--label wash]
node cli.js release input.json --id HOLD_ID_OR_LABEL
```

- Holds are temporary tank occupancies persisted in
  `<input>.state.json`. A hold is only kept if the schedule stays
  feasible; otherwise the new propagation is rolled back (state file
  untouched) and the command exits 1. Locked tasks are unaffected.
- Exit codes: `0` feasible / hold or release applied, `1` infeasible,
  unknown, or failed hold/release, `2` invalid input (illegal time or
  tank capacity).

## Tests

```
node --test
```
