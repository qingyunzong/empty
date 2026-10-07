# ticketpool

Deterministic, tick-based ticket scheduler with per-group quotas, aging-based
priority boost, and provable starvation freedom for finite streams.
Pure Python 3.11+ standard library; tests use `unittest`.

## Usage

```
python -m ticketpool serve cfg.json stream.json --out served.json
```

* `cfg.json`: `{"workers": int>=1, "aging_step": int>=1, "boost": int>=0, "base_quota": {group: int>=1}}`
* `stream.json`: `[{"id", "arrival", "cost", "group", "priority"?}]`, sorted by
  non-decreasing `arrival`. `priority` is optional (default 0, higher = more urgent).
* Exit codes: `0` success; `2` for any invalid input — unknown `group`,
  `cost <= 0`, decreasing `arrival`, malformed JSON, bad config, missing files.

## Scheduling semantics

* Time is discrete ticks. Each busy worker processes 1 unit of cost per tick;
  a ticket completes after accumulating `cost` units. Service is
  non-preemptive: `end - start + 1 == cost`.
* Per tick, group `g` has at most `base_quota[g]` tickets in service. Since
  each running ticket consumes 1 unit/tick, the concurrency cap is exactly a
  per-tick service-unit cap; unused quota does not carry over.
* A waiting ticket's effective priority is
  `priority + (waited // aging_step) * boost` — monotonically non-decreasing.
  Scheduling order key: `(-effective_priority, arrival, id)`.
* If the best waiting ticket's group is at quota, it is skipped for this tick
  and the worker may serve a ticket of another under-quota group. Quota is
  never reserved for (transferred to) groups with nothing to run.
* Finite stream + finite costs => every ticket completes; long waits are
  never reported as unsatisfiable.

## Output format

`served.json` (deterministic, byte-identical across identical runs):

```json
{"completed": N, "tickets": [{"id", "group", "start", "end", "waits"}]}
```

`start`/`end` are inclusive tick indices of the first/last unit of service;
`waits` is a list of half-open tick intervals `[begin, end)` spent arrived but
unserved (exactly one interval under non-preemptive service). Tickets are
emitted in stream order.

## Starvation freedom (proof sketch)

For a finite stream: a waiting ticket's effective priority grows without
bound while it waits (`boost > 0`; if `boost == 0` the stream is still finite,
see below). All rival tickets are finite in number and each has a fixed base
priority, so after finitely many ticks the ticket's key
`(-eff, arrival, id)` becomes strictly minimal among the waiting set. Workers
become free infinitely often until the pool drains, because every running
ticket has finite cost and completes; and its group's quota slot (>= 1) is
free whenever no group-mate is running — group-mates also finish in finite
time. Hence the ticket starts after a bounded wait. Induction over the finite
waiting set shows every ticket completes, so the last `end` is bounded. With
`boost == 0`, no new arrivals occur after the finite stream ends, so the
waiting set only shrinks and still drains. The scheduler therefore never
declares a long wait unsatisfiable.

## Verified results (real runs, this repo)

Tests — `python3 -m unittest discover -s tests -v`:

```
Ran 14 tests in 1.493s
OK
```

Coverage: A (1 worker, quota 1:1, exact A/B/A/B alternation; quota blocks the
second same-group ticket), B (priority-0 ticket overtakes priority-10 arrivals
at t=8 via aging; with `boost=0` it is served last), C (2-worker flood of
priority-5 tickets: the rare ticket starts exactly at t=9 when its boosted
priority exceeds 5, all 21 tickets complete, last end <= 12), D (400 random
instances, <= 8 tickets, 2 workers, tick scheduler == independent event-loop
reference in `ticketpool/reference.py`), E (5 identical CLI runs).

CLI example — `python3 -m ticketpool serve examples/cfg.json examples/stream.json --out served.json`:

```
served 5 ticket(s); last end=4; wrote served.json   (exit code 0, completed = 5)
```

Result summary: id1 web 0->2, id2 batch 0->1, id3 batch 2->2, id4 web 3->4,
id5 batch 3->3 (id4 waits one tick at t=2 because web's quota of 1 is held by
id1; the freed worker goes to batch's id3 instead of idling).

Determinism — 5 repeated runs of the example produced identical bytes
(md5 `92480b5df788ecd9b9fed2e62f628693` for every run).

Error handling (all exit code 2, message on stderr, no output file written):

```
error: ticket 1: unknown group 'nope'
error: ticket 1: cost must be an integer > 0
error: ticket 2: arrivals must be sorted non-decreasing
```

## Layout

* `ticketpool/scheduler.py` — tick-based scheduler (primary)
* `ticketpool/reference.py` — independent event-loop reference (test oracle)
* `ticketpool/validate.py` — config/stream validation (exit code 2 cases)
* `ticketpool/__main__.py` — CLI entry point
* `tests/` — acceptance tests A–E
* `examples/` — runnable example config and stream
