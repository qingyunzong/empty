"""Input validation for ticketpool. All user-input errors raise ValidationError."""

import json


class ValidationError(Exception):
    """Raised for any invalid config or stream input (CLI exit code 2)."""


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def load_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def load_config(path):
    cfg = load_json(path)
    if not isinstance(cfg, dict):
        raise ValidationError("config must be a JSON object")
    workers = cfg.get("workers")
    if not _is_int(workers) or workers < 1:
        raise ValidationError("cfg.workers must be an integer >= 1")
    aging_step = cfg.get("aging_step")
    if not _is_int(aging_step) or aging_step < 1:
        raise ValidationError("cfg.aging_step must be an integer >= 1")
    boost = cfg.get("boost")
    if not _is_int(boost) or boost < 0:
        raise ValidationError("cfg.boost must be an integer >= 0")
    quota = cfg.get("base_quota")
    if not isinstance(quota, dict) or not quota:
        raise ValidationError("cfg.base_quota must be a non-empty object of group -> quota")
    for group, limit in quota.items():
        if not _is_int(limit) or limit < 1:
            raise ValidationError(f"cfg.base_quota[{group!r}] must be an integer >= 1")
    return {
        "workers": workers,
        "aging_step": aging_step,
        "boost": boost,
        "base_quota": dict(quota),
    }


def load_stream(path, cfg):
    data = load_json(path)
    if not isinstance(data, list):
        raise ValidationError("stream must be a JSON array of tickets")
    quota = cfg["base_quota"]
    tickets = []
    previous_arrival = None
    for position, raw in enumerate(data):
        if not isinstance(raw, dict):
            raise ValidationError(f"stream ticket #{position} must be an object")
        if "id" not in raw:
            raise ValidationError(f"stream ticket #{position} is missing 'id'")
        ticket_id = raw["id"]
        arrival = raw.get("arrival")
        if not _is_int(arrival) or arrival < 0:
            raise ValidationError(f"ticket {ticket_id!r}: arrival must be an integer >= 0")
        cost = raw.get("cost")
        if not _is_int(cost) or cost <= 0:
            raise ValidationError(f"ticket {ticket_id!r}: cost must be an integer > 0")
        group = raw.get("group")
        if not isinstance(group, str) or group not in quota:
            raise ValidationError(f"ticket {ticket_id!r}: unknown group {group!r}")
        priority = raw.get("priority", 0)
        if not _is_int(priority):
            raise ValidationError(f"ticket {ticket_id!r}: priority must be an integer")
        if previous_arrival is not None and arrival < previous_arrival:
            raise ValidationError(
                f"ticket {ticket_id!r}: arrivals must be sorted non-decreasing"
            )
        previous_arrival = arrival
        tickets.append(
            {
                "id": ticket_id,
                "arrival": arrival,
                "cost": cost,
                "group": group,
                "priority": priority,
            }
        )
    return tickets
