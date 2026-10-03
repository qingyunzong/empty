# asrs-wave-planner

Offline wave planner for automated storage/retrieval systems (自动化立库离线波次生成).
Node.js 22, standard library only, no dependencies. Plans shuttle (穿梭车) tasks
under a hard battery budget, supports hierarchical rollback with compensation,
and verifies concurrent lane (巷道) occupancy with causal ordering.

## Layout

- `src/planner.js` — wave/task/move planning, objective ordering, minimal cut
- `src/journal.js` — append-only journal, hierarchical rollback, compensation
- `src/causal.js` — happens-before graph, lane-occupancy admission
- `src/cli.js` — `wave` / `rollback` / `verify` JSONL commands
- `test/` — `node:test` suites (run: `node --test`)

## Model

Three layers: a **wave** contains **tasks**, a task contains **moves**
(`{from,to,lane,energy,duration}`). Each task offers one or more candidate
routes (move sequences). Planning assigns every task a route and a shuttle.

Hard constraints (never violated):

- per-shuttle battery: summed move energy per shuttle ≤ its `battery`
- wave budget: total move energy ≤ `wave.budget` (equality is feasible)

Objective tuple, minimized lexicographically:

1. makespan (completion time: max per-shuttle summed durations)
2. total energy
3. plan path signature (per-task route lane sequences, tasks ordered by id)
4. reuse count (rolled-back unstarted moves offered via `reuse` hints)
5. assignment vector (per-task `[shuttle, route]`, deterministic final tie-break)

If no assignment schedules all tasks, the wave is infeasible: the CLI exits 17
and reports the **minimal reduction set** — fewest tasks to remove, ties broken
by least removed energy (per-task minimum-route energy) then task ids.

## CLI

```
node src/cli.js wave [file]            # stdin when no file (or "-")
node src/cli.js rollback <id> [file]
node src/cli.js verify [file]
```

Exit codes: `0` ok · `2` usage/invalid input · `17` budget insufficient · `18` level-skipping rollback.

### wave input

```jsonl
{"type":"wave","id":"w1","budget":20}
{"type":"shuttle","id":"s1","battery":20}
{"type":"task","id":"t1","routes":[{"moves":[{"from":"A","to":"B","lane":"L1","energy":6,"duration":4}]}]}
{"type":"reuse","task":"t2","route":0}
```

Output: `wave`, `plan` (totals), `task` (assignment), `move` records
(`status:"planned"`, id `wave/task/index`) — itself a valid rollback journal.
On infeasibility: `{"type":"error","code":"BUDGET_INSUFFICIENT","cut":[...],"deficit":N,...}`, exit 17.

### rollback

Journal records: `wave` / `task` / `move` / `status` (`planned|executing|done`)
plus previously emitted `rollback` markers. Rolling back cascades
wave → tasks → moves:

- moves already started (`executing`/`done`) get a **compensation** record
  (inverse move, same lane/energy, `of` pointing at the original) — history is
  never erased
- unstarted moves get `{"type":"cancel","reusable":true}` and may be reused in
  later waves (feed back as `reuse` hints)

Level-skipping — rolling back a target that is already settled (itself or any
ancestor already rolled back) — fails with `LEVEL_SKIP`, exit 18.

### verify input

```jsonl
{"type":"lane","id":"L1","state":"free|occupied|unknown"}
{"type":"event","id":"m1","shuttle":"s1","op":"enter","lane":"L1","after":["x0"]}
{"type":"event","id":"x1","shuttle":"s1","op":"exit","lane":"L1","of":"m1"}
```

Happens-before comes from explicit `after` edges plus per-shuttle program
order. An `enter` is **admitted** only when every other enter on the lane is
causally ordered with it and, if prior, released by an `exit` that also
happens-before it. Concurrent or unreleased occupants keep the move **pending**
with a resolvable condition (`waitFor`: establish causal order with, or await
release of, the named moves). Lanes with `unknown`/undeclared state never
block; only a known `occupied` state blocks (`lane-occupied-external`).

## Tests

```
node --test
```

Acceptance coverage:

1. `test/planner.test.js` — 200 seeded small waves compared against an
   independent exhaustive search, including tie-breaking cases
2. `test/rollback.test.js` — wave rollback then replay: energy and makespan
   never increase; executed moves compensated, unstarted moves reusable
3. `test/causal.test.js` — only causally provably safe enters are admitted;
   conflicts stay pending with resolvable conditions
4. boundary budget exactly equal to demand is feasible
   (`test/planner.test.js`, `test/cli.test.js`)

CLI tests run in-process via `runCli()` because the sandbox forbids child
processes; real process exit codes (0/17/18/2) were verified via shell.
