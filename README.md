# offline-scheduler

Deterministic offline production scheduler: Node.js 22, standard library only,
`node:test` for tests. Schedules up to 20 jobs on two devices minimizing maximum
lateness (Lmax), with a transactional WAL-backed store, crash recovery, and a
JSON CLI.

## Layout

- `src/scheduler.js` — exact scheduling algorithm + exhaustive reference enumerator
- `src/store.js` — transactional versioned store (WAL, recovery, secondary index)
- `src/util.js` — canonical JSON + SHA-256
- `bin/cli.js` — offline JSON CLI
- `test/` — `node --test` suites

## Scheduling semantics

Each job: `{ id, release, due, duration, devices? }` (`devices` defaults to the
whole fleet; fleet defaults to `["M1","M2"]`). A plan assigns every job to one
eligible device and orders each device's queue; a job starts at
`max(release, previous completion)` on its device. Plans are compared by:

1. **objective**: max lateness `max(end - due)`, lower wins;
2. **assignment key**: device ids of jobs in jobId-sorted order, lexicographic;
3. **sequence key**: per-device job sequences (device order), lexicographic.

`schedule(jobs, devices)` is exact and deterministic:

- **Phase 1** computes the optimal Lmax with branch & bound over
  (job, device) placements, using lower-bound and Pareto-dominance pruning.
- **Phase 2** reconstructs the tie-break-minimal plan greedily: the
  lexicographically smallest feasible assignment vector (jobId order), then the
  lexicographically smallest feasible sequence per device, each step validated
  by an exact bounded-feasibility check.

Errors: `E_INVALID` (malformed input), `E_INFEASIBLE` (first unschedulable
`jobId`: no eligible device, or more than 20 jobs).

The certificate contains `inputHash` (SHA-256 of canonical `{devices, jobs}`),
`objective`, and for `n <= 6` the `tieRank` (1-based position of the chosen plan
among all Lmax-optimal plans in canonical permutation x device-choice
enumeration order) and `optimalCount`.

## Store

`Store.open(dir)` replays `dir/wal.log` (JSON lines, `write`+`fsync` per
record). Record types: `jobs` (committed job-set update, bumps `jobsVersion`),
`plan_stage` (staged plan + `baseVersion`), `plan_commit` (commit marker).
Recovery applies only staged plans with a matching commit marker; a torn final
line is ignored. A committed plan keeps a `(jobId, deviceId)` secondary index
(`store.lookup`), rebuilt on recovery.

Transaction flow: `tx = store.begin()` (reads `jobsVersion` snapshot) ->
`store.stage(tx, plan)` -> `store.commit(tx)`. Commit throws `E_SNAPSHOT` when
the job set changed since `begin`. Failed/infeasible planning never touches the
WAL, so a previous committed plan stays visible.

## CLI

All commands print one JSON line; exit codes: `0` ok, `1` `E_*` error,
`2` usage, `3` injected crash.

```sh
node bin/cli.js set-jobs --dir D --jobs '{"devices":["M1","M2"],"jobs":[...]}'
node bin/cli.js plan --dir D [--expect-version N] [--crash after_stage|after_commit]
node bin/cli.js show --dir D
node bin/cli.js query --dir D --job-id A --device-id M1
```

## Test

```sh
node --test
```
