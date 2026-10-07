"""Independent event-loop reference implementation.

Instead of visiting every tick, this simulator jumps directly between
events (ticket arrivals and service completions). Scheduling decisions can
only change at those moments, so the results must be identical to the
tick-based scheduler in ticketpool.scheduler; the fuzz tests assert that.
"""


def _id_key(value):
    if isinstance(value, bool):
        return (1, str(value))
    if isinstance(value, (int, float)):
        return (0, value)
    return (1, str(value))


def _effective_priority(ticket, now, aging_step, boost):
    return ticket["priority"] + ((now - ticket["arrival"]) // aging_step) * boost


def serve_reference(cfg, tickets):
    workers = cfg["workers"]
    aging_step = cfg["aging_step"]
    boost = cfg["boost"]
    quota = cfg["base_quota"]

    total = len(tickets)
    if total == 0:
        return []

    arrival_order = sorted(
        range(total), key=lambda i: (tickets[i]["arrival"], _id_key(tickets[i]["id"]))
    )
    results = [None] * total
    waiting = []
    running = []  # entries: [free_time, ticket_index]; worker free at free_time
    free_workers = workers
    next_arrival = 0
    done = 0
    now = tickets[arrival_order[0]]["arrival"]

    while done < total:
        # completions whose worker becomes available at `now`
        still_running = []
        for free_time, index in running:
            if free_time <= now:
                results[index]["end"] = free_time - 1
                done += 1
                free_workers += 1
            else:
                still_running.append([free_time, index])
        running = still_running

        # arrivals up to `now`
        while (
            next_arrival < total
            and tickets[arrival_order[next_arrival]]["arrival"] <= now
        ):
            waiting.append(arrival_order[next_arrival])
            next_arrival += 1

        # assignment round
        if free_workers > 0 and waiting:
            in_service = {}
            for _free_time, index in running:
                group = tickets[index]["group"]
                in_service[group] = in_service.get(group, 0) + 1
            candidates = sorted(
                waiting,
                key=lambda i: (
                    -_effective_priority(tickets[i], now, aging_step, boost),
                    tickets[i]["arrival"],
                    _id_key(tickets[i]["id"]),
                ),
            )
            for index in candidates:
                if free_workers == 0:
                    break
                group = tickets[index]["group"]
                if in_service.get(group, 0) >= quota[group]:
                    continue
                waiting.remove(index)
                running.append([now + tickets[index]["cost"], index])
                in_service[group] = in_service.get(group, 0) + 1
                free_workers -= 1
                results[index] = {
                    "id": tickets[index]["id"],
                    "group": group,
                    "start": now,
                    "end": None,
                    "waits": [[tickets[index]["arrival"], now]],
                }

        if done == total:
            break

        # jump to the next event: an arrival or a worker becoming free
        future = []
        if next_arrival < total:
            future.append(tickets[arrival_order[next_arrival]]["arrival"])
        for free_time, _index in running:
            future.append(free_time)
        now = min(future)

    return results
