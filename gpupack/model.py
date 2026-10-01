"""Input model and validation for gpupack."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Union

JobId = Union[str, int]

_MISSING = object()


class ProblemError(Exception):
    """Raised when the input specification is invalid (CLI exit code 2)."""


def id_key(value: JobId) -> tuple:
    """Canonical, total ordering key for ids (ints sort before strings)."""
    if isinstance(value, int) and not isinstance(value, bool):
        return (0, value)
    return (1, str(value))


@dataclass(frozen=True)
class Gpu:
    id: JobId
    mem: int
    sm: int


@dataclass(frozen=True)
class Job:
    id: JobId
    mem: int
    sm: int
    shareable: bool
    preemptible: bool
    arrival: int
    duration: int


@dataclass(frozen=True)
class Problem:
    gpus: tuple
    jobs: tuple


def _check_id(value: Any, ctx: str) -> JobId:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ProblemError(f"{ctx}: 'id' must be a string or an integer")
    return value


def _req_int(raw: dict, key: str, min_value: int, ctx: str) -> int:
    value = raw.get(key, _MISSING)
    if value is _MISSING:
        raise ProblemError(f"{ctx}: missing required field {key!r}")
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProblemError(f"{ctx}: field {key!r} must be an integer")
    if value < min_value:
        raise ProblemError(f"{ctx}: field {key!r} must be >= {min_value}")
    return value


def _req_bool(raw: dict, key: str, ctx: str) -> bool:
    value = raw.get(key, _MISSING)
    if value is _MISSING:
        raise ProblemError(f"{ctx}: missing required field {key!r}")
    if not isinstance(value, bool):
        raise ProblemError(f"{ctx}: field {key!r} must be a boolean")
    return value


def _parse_gpu(raw: Any, index: int) -> Gpu:
    ctx = f"gpus[{index}]"
    if not isinstance(raw, dict):
        raise ProblemError(f"{ctx}: must be an object")
    if "id" not in raw:
        raise ProblemError(f"{ctx}: missing required field 'id'")
    return Gpu(
        id=_check_id(raw["id"], ctx),
        mem=_req_int(raw, "mem", 0, ctx),
        sm=_req_int(raw, "sm", 0, ctx),
    )


def _parse_job(raw: Any, index: int) -> Job:
    ctx = f"requests[{index}]"
    if not isinstance(raw, dict):
        raise ProblemError(f"{ctx}: must be an object")
    if "id" not in raw:
        raise ProblemError(f"{ctx}: missing required field 'id'")
    return Job(
        id=_check_id(raw["id"], ctx),
        mem=_req_int(raw, "mem", 0, ctx),
        sm=_req_int(raw, "sm", 0, ctx),
        shareable=_req_bool(raw, "shareable", ctx),
        preemptible=_req_bool(raw, "preemptible", ctx),
        arrival=_req_int(raw, "arrival", 0, ctx),
        duration=_req_int(raw, "duration", 1, ctx),
    )


def parse_problem(data: Any) -> Problem:
    """Validate raw JSON data and return a Problem. Raises ProblemError."""
    if not isinstance(data, dict):
        raise ProblemError("top-level value must be an object")
    gpus_raw = data.get("gpus", _MISSING)
    if gpus_raw is _MISSING:
        raise ProblemError("missing required field 'gpus'")
    if not isinstance(gpus_raw, list):
        raise ProblemError("'gpus' must be a list")
    reqs_raw = data.get("requests", _MISSING)
    if reqs_raw is _MISSING:
        raise ProblemError("missing required field 'requests'")
    if not isinstance(reqs_raw, list):
        raise ProblemError("'requests' must be a list")

    gpus = tuple(_parse_gpu(raw, i) for i, raw in enumerate(gpus_raw))
    jobs = tuple(_parse_job(raw, i) for i, raw in enumerate(reqs_raw))

    gpu_ids = [g.id for g in gpus]
    if len({id_key(i) for i in gpu_ids}) != len(gpu_ids):
        raise ProblemError("duplicate gpu id")
    job_ids = [j.id for j in jobs]
    if len({id_key(i) for i in job_ids}) != len(job_ids):
        raise ProblemError("duplicate request id")
    return Problem(gpus=gpus, jobs=jobs)
