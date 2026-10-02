# tank-scheduler

Offline tank (vessel) scheduling library and CLI. Pure Node.js 22 standard
library, no dependencies. Tasks are blended batches assigned to stirring
tanks; tank id and start time are modeled as finite domains, with
propagation of capacity, material-compatibility and cleaning-boundary
constraints, and backtracking search over task ordering.

## Problem format (`input.json`)

```json
{
  "horizon": 40,
  "tanks": [{ "id": "T1", "material": "steel", "capacity": 500 }],
  "compatibility": { "X": ["steel"], "Y": ["steel", "glass"] },
  "cleaning": [{ "from": "X", "to": "Y", "time": 15 }],
  "tasks": [
    { "id": "J1", "material": "X", "minCapacity": 100, "maxCapacity": 500,
      "earliestStart": 0, "latestStart": 20, "duration": 10 },
    { "id": "J2", "material": "Y", "minCapacity": 100, "maxCapacity": 500,
      "earliestStart": 0, "duration": 8,
      "locked": true, "tank": "T1", "start": 0 }
  ]
}
```

- `horizon`: positive integer; every task must finish by `horizon`.
- Tank: `id`, `material`, integer `capacity > 0`.
- Task: `material`, integer `minCapacity`/`maxCapacity` (tank capacity must
  lie inside), integer `earliestStart >= 0`, integer `duration > 0`,
  optional `latestStart` (defaults to `horizon - duration`).
- `locked: true` tasks pin `tank` and `start` and are never moved.
- `compatibility` maps task material to allowed tank materials (absent =
  all compatible). `cleaning` lists required cleaning time between
  consecutive different materials on the same tank (same material = 0,
  unlisted pairs = 0).

## CLI

```
node src/cli.js assign  input.json [--budget N] [--state PATH]
node src/cli.js hold    input.json --id H1 --tank T1 --start 10 --duration 5 [--material X]
node src/cli.js release input.json (--id H1 | --all)
```

- `assign` prints one of:
  - `{"status":"feasible","assignments":[{task,tank,start,end}...]}`
  - `{"status":"infeasible","conflict":{tasks,locked,holds,tanks,cleaning}}`
    — a deletion-minimal set of tasks that stays infeasible, plus the
    compatible tanks and the cleaning rules between their materials.
  - `{"status":"unknown","pending":[taskIds]}` when the node budget is
    exhausted before a verdict.
- `hold` registers a temporary occupation (persisted in
  `<input>.state.json`). If the added propagation wipes out a domain, the
  hold is rolled back — locked tasks and earlier holds are unaffected and
  the state file is left untouched.
- `release` removes a hold so the tank window becomes usable again.

Exit codes: `0` feasible / hold or release succeeded, `1` infeasible or
hold/release failed, `2` invalid input (illegal time, capacity, or
references), `3` unknown (budget exhausted).

## Library

```js
import { validateProblem } from './src/problem.js';
import { Scheduler } from './src/scheduler.js';
import { minimalConflict } from './src/conflict.js';

const problem = validateProblem(JSON.parse(raw));
const scheduler = new Scheduler(problem, { holds: [] });
scheduler.hold({ id: 'H1', tank: 'T1', start: 10, duration: 5, material: 'X' });
scheduler.release('H1');
const result = scheduler.solve({ budget: 100000 });
// {status:'feasible',assignments} | {status:'infeasible'} | {status:'unknown',pending}
const conflict = minimalConflict(problem);
```

## Tests

`node --test` (Node v22.22.1). Recorded real results:

```
✔ test/cli.test.js
✔ test/scheduler.test.js
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

Individual cases (all passing):

- `test/scheduler.test.js`
  - two tanks, three tasks: feasible, verified by enumeration
  - locked task with no feasible window yields a minimal conflict
  - tiny budget returns unknown with pending tasks
  - failed hold rolls back; locked tasks unaffected; release restores
  - hold forces task off a tank; assignment respects the occupation
- `test/cli.test.js`
  - assign: feasible problem exits 0 with valid assignments
  - assign: locked task conflict exits 1 with minimal conflict
  - tiny budget is unknown; release then re-solve is feasible
  - hold that violates cleaning fails and leaves no state behind
  - illegal time or capacity exits 2
