"""Input validation for gpupack request files."""

from __future__ import annotations

from .solver import Gpu, Job


class ValidationError(Exception):
    """Raised for malformed request files (CLI exit code 2)."""


def _is_int(value):
    return type(value) is int  # bool is explicitly rejected


def _check_id(value, where):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValidationError(f"{where}: 'id' must be a string or an integer")
    return value


def _check_int(value, where, field, minimum):
    if not _is_int(value):
        raise ValidationError(f"{where}: '{field}' must be an integer")
    if value < minimum:
        raise ValidationError(f"{where}: '{field}' must be >= {minimum}")
    return value


def _check_bool(value, where, field):
    if type(value) is not bool:
        raise ValidationError(f"{where}: '{field}' must be a boolean")
    return value


def _require(raw, field, where):
    if not isinstance(raw, dict):
        raise ValidationError(f"{where}: must be an object")
    if field not in raw:
        raise ValidationError(f"{where}: missing field '{field}'")
    return raw[field]


def _check_unique_and_homogeneous(ids, what):
    if len(set(ids)) != len(ids):
        raise ValidationError(f"duplicate {what} id")
    types = {type(i) for i in ids}
    if len(types) > 1:
        raise ValidationError(f"{what} ids must not mix strings and integers")


def parse_instance(data):
    """Validate raw JSON data and return ``(gpus, jobs)``.

    Raises :class:`ValidationError` on any illegal field.
    """
    if not isinstance(data, dict):
        raise ValidationError("top-level value must be an object")
    for key in ("gpus", "requests"):
        if key not in data:
            raise ValidationError(f"missing top-level key '{key}'")
    if not isinstance(data["gpus"], list):
        raise ValidationError("'gpus' must be a list")
    if not isinstance(data["requests"], list):
        raise ValidationError("'requests' must be a list")

    gpus = []
    for idx, raw in enumerate(data["gpus"]):
        where = f"gpus[{idx}]"
        gid = _check_id(_require(raw, "id", where), where)
        mem = _check_int(_require(raw, "mem", where), where, "mem", 0)
        sm = _check_int(_require(raw, "sm", where), where, "sm", 0)
        gpus.append(Gpu(id=gid, mem=mem, sm=sm))
    _check_unique_and_homogeneous([g.id for g in gpus], "gpu")

    jobs = []
    for idx, raw in enumerate(data["requests"]):
        where = f"requests[{idx}]"
        jid = _check_id(_require(raw, "id", where), where)
        mem = _check_int(_require(raw, "mem", where), where, "mem", 0)
        sm = _check_int(_require(raw, "sm", where), where, "sm", 0)
        shareable = _check_bool(_require(raw, "shareable", where), where, "shareable")
        preemptible = _check_bool(_require(raw, "preemptible", where), where, "preemptible")
        arrival = _check_int(_require(raw, "arrival", where), where, "arrival", 0)
        duration = _check_int(_require(raw, "duration", where), where, "duration", 1)
        jobs.append(Job(id=jid, mem=mem, sm=sm, shareable=shareable,
                        preemptible=preemptible, arrival=arrival,
                        duration=duration))
    _check_unique_and_homogeneous([j.id for j in jobs], "request")
    return gpus, jobs
