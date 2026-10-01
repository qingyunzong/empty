# gpupack

Deterministic discrete-time GPU job scheduler (Python 3.11+, standard library only).

## Usage

```bash
python -m gpupack schedule req.json --out alloc.json
```

* `req.json`: `{"gpus": [{"id", "mem", "sm"}], "requests": [{"id", "mem", "sm", "shareable", "preemptible", "arrival", "duration"}]}`; all times are integers.
* `--out` omitted: the allocation is written to stdout.
* Output: `{"jobs": [{"id", "start", "end", "gpu", "preemptions"}]}` (jobs sorted by id, keys sorted, byte-deterministic). `gpu` is the GPU the job completed on; `start` is its first start tick; `preemptions` counts evictions.
* No feasible schedule: the output is the single line `INFEASIBLE` (exit code 0).
* Invalid input (bad JSON, missing/ill-typed fields, duplicate ids) or usage errors: message on stderr, exit code 2.

## Semantics

* **Tick model.** Integer time. At each tick completions free their GPUs first, then per GPU the scheduler may evict any number of running jobs and start at most one job. A job started at `t` occupies `[t, t+1)`; a job with `duration` d started at `t` and never preempted ends at `t + d`.
* **Sharing.** A non-shareable job exclusively occupies its GPU. Shareable jobs may co-locate while the sums of `mem` and `sm` stay within the GPU's capacity.
* **Priority.** `(-arrival, id)`; the smaller tuple has higher priority (later arrivals preempt earlier ones; ties broken by smaller id).
* **Preemption.** Only `preemptible: true` jobs can be evicted, and an eviction is legal only when a strictly higher-priority job starts on the same GPU in the same tick (the evictor takes the freed slot). An evicted job keeps its remaining duration.
* **Restart.** Rescheduling a preempted job costs 1 restart tick (its first tick back occupies the GPU without progress). It may not return to the GPU it was evicted from while that GPU is still occupied.
* **Objective.** Minimize the sum of completion times. Ties are broken lexicographically: jobs ordered by id, comparing `(start, end, gpu, preemptions)`.
* **Feasibility.** A job that fits on no GPU (`mem`/`sm` exceed every GPU) makes the instance `INFEASIBLE`; otherwise a feasible schedule always exists.

## Algorithm

Exact branch-and-bound over all legal schedules (iterative DFS, dominance
memoization, lower-bound pruning, deterministic action ordering), seeded with
a deterministic priority-greedy incumbent. If a fixed node budget
(`MAX_NODES = 2_000_000`) is exceeded, the greedy schedule is returned.
The search contains no randomness or wall-clock dependence, so repeated runs
are byte-identical.

## Acceptance mapping

* **A** (shareable bin-packing): `tests/test_acceptance.py::TestAShareableBinPacking`
* **B** (preemption + 1-tick restart): `tests/test_acceptance.py::TestBPreemptionRestart`
* **C** (non-shareable vs shareable ordering): `tests/test_acceptance.py::TestCConflictOrdering`
* **D** (<=5 jobs, <=2 GPUs, exhaustive enumeration cross-check): `tests/test_bruteforce.py`
* **E** (byte-identical repeated runs): `tests/test_acceptance.py::TestEDeterminism`
* Preemption legality / no-return rule: `tests/test_preemption_rules.py`
* Validation, INFEASIBLE, exit codes: `tests/test_validation.py`

## Recorded run (2026-10-01, Python 3.14.4)

Tests (`python -m unittest discover -s tests -v`):

```
test_packing (test_acceptance.TestAShareableBinPacking.test_packing) ... ok
test_preemption_and_restart_tick (test_acceptance.TestBPreemptionRestart.test_preemption_and_restart_tick) ... ok
test_ordering (test_acceptance.TestCConflictOrdering.test_ordering) ... ok
test_byte_identical (test_acceptance.TestEDeterminism.test_byte_identical) ... ok
test_handcrafted_instances (test_bruteforce.TestDBruteForce.test_handcrafted_instances) ... ok
test_random_instances (test_bruteforce.TestDBruteForce.test_random_instances) ... ok
test_eviction_requires_same_gpu_higher_priority_start (test_preemption_rules.TestEvictionJustification.test_eviction_requires_same_gpu_higher_priority_start) ... ok
test_no_eviction_without_higher_priority_starter (test_preemption_rules.TestEvictionJustification.test_no_eviction_without_higher_priority_starter) ... ok
test_can_return_once_original_gpu_is_free (test_preemption_rules.TestNoReturnRule.test_can_return_once_original_gpu_is_free) ... ok
test_cannot_return_to_occupied_original_gpu (test_preemption_rules.TestNoReturnRule.test_cannot_return_to_occupied_original_gpu) ... ok
test_empty_requests (test_validation.TestEdgeCases.test_empty_requests) ... ok
test_stdout_when_no_out (test_validation.TestEdgeCases.test_stdout_when_no_out) ... ok
test_no_gpus_with_requests (test_validation.TestInfeasible.test_no_gpus_with_requests) ... ok
test_non_shareable_exceeds_every_gpu (test_validation.TestInfeasible.test_non_shareable_exceeds_every_gpu) ... ok
test_shareable_exceeds_every_gpu (test_validation.TestInfeasible.test_shareable_exceeds_every_gpu) ... ok
test_bool_mem (test_validation.TestInvalidInput.test_bool_mem) ... ok
test_duplicate_gpu_id (test_validation.TestInvalidInput.test_duplicate_gpu_id) ... ok
test_duplicate_job_id (test_validation.TestInvalidInput.test_duplicate_job_id) ... ok
test_malformed_json (test_validation.TestInvalidInput.test_malformed_json) ... ok
test_missing_field (test_validation.TestInvalidInput.test_missing_field) ... ok
test_missing_gpus (test_validation.TestInvalidInput.test_missing_gpus) ... ok
test_missing_input_file (test_validation.TestInvalidInput.test_missing_input_file) ... ok
test_missing_requests (test_validation.TestInvalidInput.test_missing_requests) ... ok
test_negative_arrival (test_validation.TestInvalidInput.test_negative_arrival) ... ok
test_not_an_object (test_validation.TestInvalidInput.test_not_an_object) ... ok
test_usage_error_is_exit_2 (test_validation.TestInvalidInput.test_usage_error_is_exit_2) ... ok
test_wrong_type_shareable (test_validation.TestInvalidInput.test_wrong_type_shareable) ... ok
test_zero_duration (test_validation.TestInvalidInput.test_zero_duration) ... ok

----------------------------------------------------------------------
Ran 28 tests in 21.005s

OK
```

CLI runs (real results):

| Command | Exit code | Result |
| --- | --- | --- |
| `python -m gpupack schedule examples/req.json --out examples/alloc.json` | 0 | 6 jobs scheduled, objective = 45 |
| `python -m gpupack schedule infeasible.json --out out.json` (job `mem` exceeds every GPU, non-shareable) | 0 | `INFEASIBLE` |
| `python -m gpupack schedule bad.json` (`shareable: "yes"`) | 2 | `error: requests[0]: field 'shareable' must be a boolean` |

`examples/alloc.json` sha256:
`61dea109232b5089ae4ad8d3005b4e25ad0e12b2aede5f500e5bd4ac3bc180dc`

`examples/alloc.json` contents:

```json
{
  "jobs": [
    {"end": 6, "gpu": "g0", "id": "infer-1", "preemptions": 0, "start": 1},
    {"end": 6, "gpu": "g0", "id": "infer-2", "preemptions": 0, "start": 2},
    {"end": 10, "gpu": "g0", "id": "infer-3", "preemptions": 0, "start": 4},
    {"end": 6, "gpu": "g1", "id": "train-a", "preemptions": 0, "start": 0},
    {"end": 8, "gpu": "g2", "id": "train-b", "preemptions": 0, "start": 0},
    {"end": 9, "gpu": "g1", "id": "train-c", "preemptions": 0, "start": 6}
  ]
}
```
