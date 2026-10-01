"""Deterministic fair-queueing simulator with weighted DRF service.

Semantics
---------
* Events: ``submit(t, flow, size, prio)``, ``tick(t)``, ``capacity(c)``.
* Input events must be non-decreasing in ``t`` (duplicate times are legal).
  Events at the same time are ordered: submit, then capacity, then tick;
  ties are broken by flow id and finally by input order.
* ``capacity(c)`` sets the number of service units available per tick.
  Unused capacity does not accumulate. Default capacity is 1.
* A flow's weight is ``max(1, prio)``.
* At each tick, up to ``capacity`` units are served.  For every unit the
  eligible flow with the smallest ``served / weight`` ratio is chosen
  (weighted DRF); ties are broken by the smaller flow id.
* A flow submitted at time ``t`` is *not* eligible at a tick at time ``t``;
  arrivals only take effect at the next tick (no intra-tick preemption).
* A flow that receives its last unit at tick ``t`` gets ``finish_t = t``.
  A zero-size flow finishes immediately at its submit time.
* Starvation: a flow is starved if it spends more than ``STARVE_WINDOW``
  time units active without receiving service, measured between its submit
  time, its own service times, and its finish time (or the last tick).
"""

from __future__ import annotations

from fractions import Fraction

STARVE_WINDOW = 100
DEFAULT_CAPACITY = 1

_EVENT_ORDER = {"submit": 0, "capacity": 1, "tick": 2}


class SimError(Exception):
    """Validation or simulation error, reported by the CLI as JSON."""

    def __init__(self, code, message, index=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.index = index

    def to_dict(self):
        payload = {"error": self.message, "code": self.code}
        if self.index is not None:
            payload["event_index"] = self.index
        return payload


def _require_int(value, field, index):
    if isinstance(value, bool) or not isinstance(value, int):
        raise SimError(
            "invalid_event",
            "event %d: field %r must be an integer" % (index, field),
            index,
        )
    return value


def validate_events(raw):
    """Validate the raw event list and return it in canonical order."""
    if not isinstance(raw, list):
        raise SimError("invalid_input", "top-level JSON value must be a list of events")
    events = []
    prev_t = None
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise SimError("invalid_event", "event %d: must be an object" % index, index)
        etype = item.get("type")
        if etype not in _EVENT_ORDER:
            raise SimError(
                "invalid_event", "event %d: unknown type %r" % (index, etype), index
            )
        if "t" in item:
            t = _require_int(item["t"], "t", index)
        elif etype == "capacity":
            t = prev_t if prev_t is not None else 0
        else:
            raise SimError("invalid_event", "event %d: missing field 't'" % index, index)
        if prev_t is not None and t < prev_t:
            raise SimError(
                "time_regression",
                "event %d: time moves backwards (%d -> %d)" % (index, prev_t, t),
                index,
            )
        prev_t = t
        ev = {"type": etype, "t": t, "index": index}
        if etype == "submit":
            flow = _require_int(item.get("flow"), "flow", index)
            size = _require_int(item.get("size"), "size", index)
            prio = _require_int(item.get("prio"), "prio", index)
            if size < 0:
                raise SimError(
                    "negative_size", "event %d: size must be >= 0" % index, index
                )
            ev.update(flow=flow, size=size, prio=prio)
        elif etype == "capacity":
            c = _require_int(item.get("c"), "c", index)
            if c <= 0:
                raise SimError(
                    "invalid_capacity", "event %d: capacity must be > 0" % index, index
                )
            ev["c"] = c
        events.append(ev)
    events.sort(
        key=lambda e: (e["t"], _EVENT_ORDER[e["type"]], e.get("flow", 0), e["index"])
    )
    return events


class _Flow:
    def __init__(self, flow_id, prio, size, submit_t):
        self.flow = flow_id
        self.prio = prio
        self.weight = max(1, prio)
        self.size = size
        self.remaining = size
        self.served = 0
        self.submit_t = submit_t
        self.finish_t = None
        self.ref_t = submit_t
        self.starved = False

    def note_service(self, t):
        if t - self.ref_t > STARVE_WINDOW:
            self.starved = True
        self.ref_t = t

    def to_dict(self):
        return {
            "flow": self.flow,
            "prio": self.prio,
            "weight": self.weight,
            "size": self.size,
            "submit_t": self.submit_t,
            "served": self.served,
            "remaining": self.remaining,
            "finish_t": self.finish_t,
            "starved": self.starved,
        }


def simulate(raw_events):
    """Run the simulation; return ``(result_dict, log_lines)``."""
    events = validate_events(raw_events)
    flows = {}
    capacity = DEFAULT_CAPACITY
    service = []
    log = []
    tick_count = 0
    last_tick_t = None

    for ev in events:
        t = ev["t"]
        kind = ev["type"]
        if kind == "submit":
            fid = ev["flow"]
            if fid in flows:
                raise SimError(
                    "duplicate_flow",
                    "event %d: flow %d submitted twice" % (ev["index"], fid),
                    ev["index"],
                )
            flow = _Flow(fid, ev["prio"], ev["size"], t)
            flows[fid] = flow
            log.append(
                "submit t=%d flow=%d size=%d prio=%d weight=%d"
                % (t, fid, flow.size, flow.prio, flow.weight)
            )
            if flow.size == 0:
                flow.finish_t = t
                log.append("finish t=%d flow=%d" % (t, fid))
        elif kind == "capacity":
            capacity = ev["c"]
            log.append("capacity t=%d c=%d" % (t, capacity))
        else:
            tick_count += 1
            last_tick_t = t
            budget = capacity
            units = {}
            order = []
            while budget > 0:
                eligible = [
                    f for f in flows.values() if f.remaining > 0 and f.submit_t < t
                ]
                if not eligible:
                    break
                eligible.sort(key=lambda f: (Fraction(f.served, f.weight), f.flow))
                flow = eligible[0]
                flow.served += 1
                flow.remaining -= 1
                flow.note_service(t)
                budget -= 1
                if flow.flow not in units:
                    units[flow.flow] = 0
                    order.append(flow.flow)
                units[flow.flow] += 1
                if flow.remaining == 0:
                    flow.finish_t = t
            for fid in order:
                service.append({"t": t, "flow": fid, "units": units[fid]})
                log.append("tick t=%d serve flow=%d units=%d" % (t, fid, units[fid]))
            for fid in order:
                if flows[fid].finish_t == t:
                    log.append("finish t=%d flow=%d" % (t, fid))
            if not order:
                log.append("tick t=%d idle" % t)

    for flow in flows.values():
        if flow.finish_t is None and last_tick_t is not None:
            if last_tick_t - flow.ref_t > STARVE_WINDOW:
                flow.starved = True

    starved_ids = sorted(f.flow for f in flows.values() if f.starved)
    for fid in starved_ids:
        log.append("starved flow=%d" % fid)

    result = {
        "flows": [f.to_dict() for f in sorted(flows.values(), key=lambda f: f.flow)],
        "starved": starved_ids,
        "service": service,
        "ticks": tick_count,
    }
    return result, log
