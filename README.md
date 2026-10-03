# furnace-batch-planner

Offline furnace batch scheduling library and CLI. Node.js 22, standard library
only, tests with `node:test`. No network access required at any point.

## Model

- One furnace processes **runs** (炉次), numbered sequentially. Each run has a
  capacity (units) and may **mix orders whose recipes share a compatibility
  group** (混炉). Switching the group between consecutive runs costs
  `cleanTime` (清炉).
- Each recipe has a **daily quota** (配额, units/day). A run that would exceed
  today's quota is shifted to the next day boundary.
- **Urgent orders preempt normal ones at run boundaries** (紧急抢占): on a
  rolling update the urgent order takes the next run; the already-loaded part
  of normal orders (in frozen runs) is kept, the unloaded remainder returns to
  the waiting queue and **ages** (`effectiveDue = due - agingRate * waited`).
- **Rolling plan** (滚动更新): runs starting before the freeze boundary are
  frozen and never move. Canceling an unfrozen order releases its quota; if
  tooling preparation already happened for it (it appeared in a published
  plan), a fixed compensation slot (补偿时隙) is deducted from the furnace
  timeline right after the frozen part and added to the objective.
- **Objective**: minimize `total tardiness + cleaning + compensation`
  (per-batch tardiness against the order due date). Ties prefer loads in
  lower-numbered runs (并列按炉次编号).
- **Infeasible inputs fail**: a batch larger than the furnace capacity, an
  unsupported recipe group, an unknown recipe, or a quota that can never fit
  one batch.

## Usage

```sh
node src/cli.js plan   examples/plan-input.json --state state.json
node src/cli.js replan examples/replan-events.json --state state.json
node src/cli.js verify examples/plan-input.json
npm test
```

- `plan`: input `{ config, orders, freezeBoundary? }` → prints the plan and
  (with `--state`) persists it for rolling updates.
- `replan`: events `{ now?, freezeHorizon?, add?, cancel?, prepare? }` →
  prints the new plan and the incremental diff, updates the state file.
- `verify`: for instances with ≤ 5 orders, compares the greedy plan against an
  exhaustive enumeration of every batch partition and run ordering.
- Exit codes: `0` ok, `1` usage error / verify mismatch, `2` infeasible input.

### Config

```json
{
  "capacity": 10, "runTime": 4, "cleanTime": 2, "dayLength": 24,
  "compensationSlots": 3, "agingRate": 1, "supportedGroups": ["A", "B"],
  "recipes": { "R1": { "group": "A", "dailyQuota": 12 } }
}
```

### Order

```json
{ "id": "W1", "recipe": "R1", "batches": 2, "batchSize": 3, "due": 30,
  "priority": "normal" }
```

### Output

`{ ok, revision, objective: { tardiness, cleaning, compensation, total },
freezeBoundary: { time, frozenRuns }, runs, quotaUsage, orders, diff }`

- `runs[]`: run composition — `runNo, group, start, end, day, cleanBefore,
  frozen, loads[{ order, recipe, batches, units }]`.
- `quotaUsage[]`: per day and recipe, `used` vs `quota`.
- `freezeBoundary`: freeze time and the frozen run numbers.
- `diff`: `keptRuns / removedRuns / addedRuns / canceled /
  compensationEvents` relative to the previous revision.

## Library

```js
import { Engine } from './src/engine.js';
import { greedySchedule } from './src/scheduler.js';
import { enumerateOptimal } from './src/enumerate.js';
```

`Engine` keeps the rolling state (`plan`, `replan`, JSON-serializable
`state`). `greedySchedule` is the deterministic heuristic; `enumerateOptimal`
exhaustively enumerates batch partitions and run orderings for small
instances (used by `verify` and the cross-check tests).

## Tests

`npm test` (i.e. `node --test`) covers:

1. Mixed compatible runs and daily-quota feasibility.
2. Urgent preemption at a run boundary; unloaded remainder requeues, ages,
   and continues in later runs; frozen history unchanged.
3. Canceling a prepared order charges the fixed compensation slot, releases
   quota, and leaves frozen runs untouched; canceling a fully frozen order is
   rejected.
4. Over-capacity batches and incompatible recipe groups fail with exit
   code 2.
5. For ≤ 5 orders, the greedy plan is cross-checked against exhaustive
   enumeration of batch partitions and run orderings.

Latest recorded run: `docs/test-results.txt`.
