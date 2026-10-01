"""Core tick-based simulation for ticketpool.

Semantics
---------
* Time is discrete (ticks). Each worker processes exactly 1 unit of work
  per tick; a ticket completes once it has accumulated ``cost`` units.
  Service is non-preemptive: a started ticket runs on its worker until done.
* Per tick, group ``g`` may have at most ``base_quota[g]`` tickets in
  service (its concurrency quota). Unused quota does not carry over.
  Quota that a group cannot use (no eligible waiting ticket) is never
  reserved: workers stay work-conserving and may serve other groups that
  are still below their own quota, but no group may exceed its quota.
* A waiting ticket gains ``boost`` effective priority for every full
  ``aging_step`` ticks spent unserved. Effective priority never decreases.
  Scheduling key: higher effective priority first, then earlier arrival,
  then smaller id.
"""

from __future__ import annotations


class ValidationError(Exception):
    """Raised for invalid config or stream input (CLI exit code 2)."""


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _id_key(value):
    # Total, deterministic order over int/str ids.
    if _is_int(value):
        return (0, value, "")
    if isinstance(value, str):
        return (1, 0, value)
    raise ValidationError(f"ticket id must be int or str, got {type(value).__name__}")


def validate(cfg, stream) -> None:
    if not isinstance(cfg, dict):
        raise ValidationError("cfg must be a JSON object")
    workers = cfg.get("workers")
    if not _is_int(workers) or workers < 1:
        raise ValidationError("workers must be an integer >= 1")
    aging_step = cfg.get("aging_step")
    if not _is_int(aging_step) or aging_step < 1:
        raise ValidationError("aging_step must be an integer >= 1")
    boost = cfg.get("boost")
    if not _is_int(boost) or boost < 0:
        raise ValidationError("boost must be an integer >= 0")
    quota = cfg.get("base_quota")
    if not isinstance(quota, dict) or not quota:
        raise ValidationError("base_quota must be a non-empty object")
    for group, cap in quota.items():
        if not _is_int(cap) or cap < 1:
            raise ValidationError(f"base_quota[{group!r}] must be an integer >= 1")

    if not isinstance(stream, list):
        raise ValidationError("stream must be a JSON array")
    prev_arrival = None
    for index, ticket in enumerate(stream):
        if not isinstance(ticket, dict):
            raise ValidationError(f"ticket #{index} must be an object")
        if "id" not in ticket:
            raise ValidationError(f"ticket #{index} missing id")
        _id_key(ticket["id"])
        group = ticket.get("group")
        if group not in quota:
            raise ValidationError(f"ticket {ticket['id']!r}: unknown group {group!r}")
        cost = ticket.get("cost")
        if not _is_int(cost) or cost <= 0:
            raise ValidationError(f"ticket {ticket['id']!r}: cost must be an integer > 0")
        arrival = ticket.get("arrival")
        if not _is_int(arrival) or arrival < 0:
            raise ValidationError(f"ticket {ticket['id']!r}: arrival must be an integer >= 0")
        if prev_arrival is not None and arrival < prev_arrival:
            raise ValidationError(
                f"ticket {ticket['id']!r}: arrivals must be non-decreasing "
                f"({arrival} < {prev_arrival})"
            )
        prev_arrival = arrival
        priority = ticket.get("priority", 0)
        if not _is_int(priority):
            raise ValidationError(f"ticket {ticket['id']!r}: priority must be an integer")


def _effective_priority(ticket, tick, aging_step, boost):
    waited = tick - ticket["arrival"]
    return ticket["base_priority"] + boost * (waited // aging_step)


def serve(cfg, stream):
    """Run the simulation; return a deterministic result dict."""
    validate(cfg, stream)
    workers = cfg["workers"]
    aging_step = cfg["aging_step"]
    boost = cfg["boost"]
    quota = cfg["base_quota"]

    pending = []
    for index, raw in enumerate(stream):
        pending.append(
            {
                "idx": index,
                "id": raw["id"],
                "group": raw["group"],
                "arrival": raw["arrival"],
                "cost": raw["cost"],
                "base_priority": raw.get("priority", 0),
                "remaining": raw["cost"],
                "start": None,
            }
        )

    waiting = []
    running = []
    done = []
    tick = 0
    while pending or waiting or running:
        while pending and pending[0]["arrival"] <= tick:
            waiting.append(pending.pop(0))

        usage = {}
        for ticket in running:
            usage[ticket["group"]] = usage.get(ticket["group"], 0) + 1

        free = workers - len(running)
        while free > 0 and waiting:
            best = None
            best_key = None
            for ticket in waiting:
                if usage.get(ticket["group"], 0) >= quota[ticket["group"]]:
                    continue
                eff = _effective_priority(ticket, tick, aging_step, boost)
                key = (-eff, ticket["arrival"], _id_key(ticket["id"]))
                if best_key is None or key < best_key:
                    best_key = key
                    best = ticket
            if best is None:
                break
            waiting.remove(best)
            best["start"] = tick
            running.append(best)
            usage[best["group"]] = usage.get(best["group"], 0) + 1
            free -= 1

        still_running = []
        for ticket in running:
            ticket["remaining"] -= 1
            if ticket["remaining"] == 0:
                done.append(
                    {
                        "idx": ticket["idx"],
                        "id": ticket["id"],
                        "group": ticket["group"],
                        "arrival": ticket["arrival"],
                        "start": ticket["start"],
                        "end": tick,
                        "waits": ticket["start"] - ticket["arrival"],
                    }
                )
            else:
                still_running.append(ticket)
        running = still_running
        tick += 1

    done.sort(key=lambda record: record["idx"])
    tickets = [
        {
            "id": record["id"],
            "group": record["group"],
            "arrival": record["arrival"],
            "start": record["start"],
            "end": record["end"],
            "waits": record["waits"],
        }
        for record in done
    ]
    makespan = max((record["end"] for record in done), default=-1) + 1
    return {
        "tickets": tickets,
        "summary": {"completed": len(tickets), "makespan": makespan},
    }
