# ticketpool

Deterministic tick-based multi-worker ticket scheduler with per-group
concurrency quotas, priority aging, and provable starvation freedom for
finite streams. Python 3.11+ standard library only.

## Usage

```
python -m ticketpool serve cfg.json stream.json --out served.json
```

- `cfg.json`: `{"workers": int>=1, "aging_step": int>=1, "boost": int>=0, "base_quota": {group: int>=1}}`
- `stream.json`: tickets sorted by non-decreasing `arrival`:
  `[{"id", "arrival", "cost", "group", "priority"?}, ...]` (`priority` defaults to 0).
- `served.json`: per-ticket `{id, group, arrival, start, end, waits}` plus a summary.

Exit codes: `0` success; `2` validation error (unknown group, `cost <= 0`,
non-monotone `arrival`, malformed config/JSON).

## Semantics

1. Each worker processes 1 unit of work per tick; a ticket completes after
   accumulating `cost` units. Service is non-preemptive, so `start..end` is
   contiguous and `end - start + 1 == cost`.
2. Per tick, group `g` has at most `base_quota[g]` tickets in service;
   unused quota does not carry over.
3. A ticket gains `boost` effective priority for every full `aging_step`
   ticks waited unserved; effective priority never decreases. Scheduling
   key: `(effective_priority desc, arrival asc, id asc)`.
4. Per-group concurrency never exceeds its quota. Quota a group cannot use
   is not reserved: idle workers may serve other groups that are still below
   their own quota in the same tick (work-conserving), but no group ever
   exceeds its cap.
5. For a finite stream with finite costs every ticket completes; `waits`
   records `start - arrival`. Long waits are never declared unsatisfiable.

## Starvation-freedom argument

Let T be any ticket (base priority p, arrival a). A later ticket T'
(arrival a' > a, base p' <= p) can never overtake T: its wait is always
shorter, so its effective priority never exceeds T's, and ties break to
the earlier arrival. Hence only finitely many tickets can ever be ahead of
T (those arriving no later than a, plus those with base priority > p).
Assume some set of tickets waits forever and pick among them the one, T*,
maximal by the scheduling key. After finite time every ticket that can
precede T* has completed (each runs at most `cost` ticks once started).
T*'s group has quota >= 1, its running members finish in finite time, and
the scheduler is work-conserving, so T* is then assigned a worker —
contradiction. Therefore no ticket waits forever, and with finite costs
every `end` is bounded by `max(arrival) + sum(cost)`.

## Verified results (this checkout)

CLI example (`cfg.json`, `stream.json` in repo root):

```
$ python -m ticketpool serve cfg.json stream.json --out served.json
completed=8 makespan=10 -> served.json   (exit code 0)
```

All 8 tickets completed; makespan 10 ticks; per-ticket `start/end/waits`
in `served.json`. Error paths (real runs): unknown group, `cost = 0`, and
decreasing arrivals each print `error: ...` to stderr and exit with code 2.

Test suite (`python -m unittest discover -s tests -v`): 8 tests, all OK —
A: exact 1:1 group alternation on one worker; B: aging overtakes higher
base priority; C: 60-ticket high-arrival-rate finite stream completes with
bounded `end`; D: 300 randomized cases (<=8 tickets, 2 workers) match an
independent event-loop reference; E: 5 repeated CLI runs are byte-identical;
plus exit-code-2 validation tests.
