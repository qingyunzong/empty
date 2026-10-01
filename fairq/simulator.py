"""Core deterministic scheduler simulation.

Semantics (see README.md for the full specification):

* Events are consumed in input order; timestamps must be non-decreasing.
* Events sharing the same timestamp are processed as: submits (ascending
  flow id), then capacity changes (input order), then ticks (input order).
* A flow submitted at time ``t`` becomes eligible at ticks with time > t,
  so an arrival never preempts the tick at its own arrival time.
* Each tick serves up to ``capacity`` units, one unit at a time.  Every
  unit goes to the eligible unfinished flow with the smallest
  ``served / weight`` ratio (exact fraction arithmetic); ties go to the
  smallest flow id.  Unused capacity does not accumulate.
* ``weight = max(1, prio)``.
* A flow is starved when, at a tick where service happened, it is
  unfinished and ``t - max(submit_t, last_service_t) > window`` (W=100).
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction

DEFAULT_WINDOW = 100


class SimError(Exception):
    """Raised for invalid input events (exit code 2 at the CLI)."""


def flow_key(flow_id):
    """Deterministic total order for flow ids (ints before strings)."""
    if isinstance(flow_id, bool):
        return (2, str(flow_id))
    if isinstance(flow_id, int):
        return (0, flow_id)
    return (1, str(flow_id))


@dataclass
class Flow:
    flow_id: object
    size: int
    prio: int
    submit_t: int
    remaining: int
    served: int = 0
    last_service_t: int | None = None
    finish_t: int | None = None
    starved: bool = False

    @property
    def weight(self) -> int:
        return max(1, self.prio)


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def normalize_events(raw_events):
    """Validate raw JSON events and return normalized event dicts.

    Every returned event carries an integer ``t``.  ``capacity`` events
    without an explicit ``t`` inherit the previous event's time (or 0).
    Raises :class:`SimError` on any invalid input.
    """
    if not isinstance(raw_events, list):
        raise SimError("events file must contain a JSON array")
    normalized = []
    last_t = None
    for index, raw in enumerate(raw_events):
        where = f"event #{index}"
        if not isinstance(raw, dict):
            raise SimError(f"{where}: must be an object")
        etype = raw.get("type")
        if etype not in ("submit", "tick", "capacity"):
            raise SimError(f"{where}: unknown event type {etype!r}")

        if "t" in raw:
            if not _is_int(raw["t"]):
                raise SimError(f"{where}: t must be an integer")
            t = raw["t"]
        elif etype == "capacity":
            t = last_t if last_t is not None else 0
        else:
            raise SimError(f"{where}: missing t")
        if last_t is not None and t < last_t:
            raise SimError(f"{where}: time regression ({t} < {last_t})")
        last_t = t

        if etype == "submit":
            if "flow" not in raw:
                raise SimError(f"{where}: missing flow")
            flow_id = raw["flow"]
            if not (_is_int(flow_id) or isinstance(flow_id, str)):
                raise SimError(f"{where}: flow must be an integer or string")
            if not _is_int(raw.get("size")):
                raise SimError(f"{where}: size must be an integer")
            if raw["size"] < 0:
                raise SimError(f"{where}: negative size ({raw['size']})")
            if raw["size"] == 0:
                raise SimError(f"{where}: size must be positive")
            if not _is_int(raw.get("prio")):
                raise SimError(f"{where}: prio must be an integer")
            normalized.append({
                "type": "submit", "t": t, "flow": flow_id,
                "size": raw["size"], "prio": raw["prio"],
            })
        elif etype == "tick":
            normalized.append({"type": "tick", "t": t})
        else:  # capacity
            if not _is_int(raw.get("c")):
                raise SimError(f"{where}: c must be an integer")
            if raw["c"] <= 0:
                raise SimError(f"{where}: capacity must be > 0 ({raw['c']})")
            normalized.append({"type": "capacity", "t": t, "c": raw["c"]})
    return normalized


def _run_tick(t, flows, capacity, window, log):
    served_this_tick = 0
    for _ in range(capacity):
        best = None
        for flow in flows.values():
            if flow.remaining <= 0 or flow.submit_t >= t:
                continue
            if best is None or (
                Fraction(flow.served, flow.weight),
                flow_key(flow.flow_id),
            ) < (
                Fraction(best.served, best.weight),
                flow_key(best.flow_id),
            ):
                best = flow
        if best is None:
            break
        best.remaining -= 1
        best.served += 1
        best.last_service_t = t
        served_this_tick += 1
        log.append(f"t={t} tick serve flow={best.flow_id} remaining={best.remaining}")
        if best.remaining == 0:
            best.finish_t = t
            log.append(f"t={t} finish flow={best.flow_id} finish_t={t}")
    if served_this_tick == 0:
        log.append(f"t={t} tick idle")
        return
    for flow in flows.values():
        if flow.starved or flow.remaining <= 0 or flow.submit_t > t:
            continue
        ref = flow.last_service_t if flow.last_service_t is not None else flow.submit_t
        if t - ref > window:
            flow.starved = True
            log.append(f"t={t} starved flow={flow.flow_id}")


def simulate(events, window=DEFAULT_WINDOW):
    """Run the simulation over normalized events.

    Returns ``(result_dict, log_lines)``.
    """
    if window < 0:
        raise SimError("window must be >= 0")
    flows: dict = {}
    capacity = 1
    log: list[str] = []
    index = 0
    count = len(events)
    while index < count:
        t = events[index]["t"]
        group = []
        while index < count and events[index]["t"] == t:
            group.append(events[index])
            index += 1
        submits = sorted(
            (e for e in group if e["type"] == "submit"),
            key=lambda e: flow_key(e["flow"]),
        )
        capacities = [e for e in group if e["type"] == "capacity"]
        ticks = [e for e in group if e["type"] == "tick"]
        for event in submits:
            flow_id = event["flow"]
            if flow_id in flows:
                raise SimError(f"duplicate flow id: {flow_id!r}")
            flows[flow_id] = Flow(
                flow_id=flow_id,
                size=event["size"],
                prio=event["prio"],
                submit_t=t,
                remaining=event["size"],
            )
            log.append(
                f"t={t} submit flow={flow_id} size={event['size']} prio={event['prio']}"
            )
        for event in capacities:
            capacity = event["c"]
            log.append(f"t={t} capacity c={capacity}")
        for _ in ticks:
            _run_tick(t, flows, capacity, window, log)

    result = {
        "window": window,
        "flows": {
            str(flow.flow_id): {
                "submit_t": flow.submit_t,
                "size": flow.size,
                "prio": flow.prio,
                "weight": flow.weight,
                "served": flow.served,
                "finish_t": flow.finish_t,
            }
            for flow in flows.values()
        },
        "starved": sorted(
            (flow.flow_id for flow in flows.values() if flow.starved),
            key=flow_key,
        ),
    }
    return result, log
