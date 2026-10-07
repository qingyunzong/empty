"""Tick-based, non-preemptive scheduler.

Semantics
---------
* Time is discrete ticks. Each busy worker processes exactly 1 unit of cost
  per tick; a ticket completes when it has accumulated `cost` units.
* Once a ticket starts on a worker it runs to completion (non-preemptive),
  so `start`/`end` are the first/last tick of service and
  `end - start + 1 == cost`.
* Per tick, group `g` may have at most `base_quota[g]` tickets in service
  (concurrency cap == per-tick service-unit cap, since each running ticket
  consumes 1 unit/tick). Unused quota does not carry over.
* A waiting ticket's effective priority is
  `priority + (waited // aging_step) * boost`, which never decreases while
  it waits. Scheduling order key: (-effective_priority, arrival, id).
* If the best waiting ticket's group is at its quota, the ticket is skipped
  for this tick and the worker may serve a ticket of another group that is
  under its quota. Quota is never reserved for groups with nothing to run.
"""


def id_key(value):
    """Deterministic total order for ticket ids of any JSON type."""
    if isinstance(value, bool):
        return (1, str(value))
    if isinstance(value, (int, float)):
        return (0, value)
    return (1, str(value))


def effective_priority(ticket, now, aging_step, boost):
    waited = now - ticket["arrival"]
    return ticket["priority"] + (waited // aging_step) * boost


def _order_key(ticket, now, aging_step, boost):
    return (
        -effective_priority(ticket, now, aging_step, boost),
        ticket["arrival"],
        id_key(ticket["id"]),
    )


def serve(cfg, tickets):
    """Simulate the pool. Returns per-ticket results in stream order.

    Each result: {"id", "group", "start", "end", "waits"} where `start`/`end`
    are inclusive tick indices and `waits` is a list of half-open tick
    intervals [begin, end) during which the ticket waited unserved.
    """
    workers = cfg["workers"]
    aging_step = cfg["aging_step"]
    boost = cfg["boost"]
    quota = cfg["base_quota"]

    total = len(tickets)
    if total == 0:
        return []

    arrival_order = sorted(
        range(total), key=lambda i: (tickets[i]["arrival"], id_key(tickets[i]["id"]))
    )
    results = [None] * total
    waiting = []
    running = []  # entries: [ticket_index, remaining_cost]
    free_workers = workers
    next_arrival = 0
    done = 0
    tick = tickets[arrival_order[0]]["arrival"]

    while done < total:
        while (
            next_arrival < total
            and tickets[arrival_order[next_arrival]]["arrival"] <= tick
        ):
            waiting.append(arrival_order[next_arrival])
            next_arrival += 1

        if free_workers > 0 and waiting:
            in_service = {}
            for index, _remaining in running:
                group = tickets[index]["group"]
                in_service[group] = in_service.get(group, 0) + 1
            candidates = sorted(
                waiting,
                key=lambda i: _order_key(tickets[i], tick, aging_step, boost),
            )
            for index in candidates:
                if free_workers == 0:
                    break
                group = tickets[index]["group"]
                if in_service.get(group, 0) >= quota[group]:
                    continue  # group quota full; another group may use the worker
                waiting.remove(index)
                running.append([index, tickets[index]["cost"]])
                in_service[group] = in_service.get(group, 0) + 1
                free_workers -= 1
                results[index] = {
                    "id": tickets[index]["id"],
                    "group": group,
                    "start": tick,
                    "end": None,
                    "waits": [[tickets[index]["arrival"], tick]],
                }

        still_running = []
        for index, remaining in running:
            remaining -= 1
            if remaining == 0:
                results[index]["end"] = tick
                done += 1
                free_workers += 1
            else:
                still_running.append([index, remaining])
        running = still_running

        if done < total:
            tick += 1
            if not running and not waiting and next_arrival < total:
                upcoming = tickets[arrival_order[next_arrival]]["arrival"]
                if upcoming > tick:
                    tick = upcoming

    return results
