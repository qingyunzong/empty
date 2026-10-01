"""Virtual network: deterministic schedule runner and cross-checker.

A schedule is a list of frames offered in order.  Frames answered with
deterministic backpressure (busy) or classified ambiguous (too far
ahead of the window) are parked and retried whenever the engine state
changes, modelling a sender that retransmits until acknowledged.

``compare`` runs the same schedule through the engine and through the
independent unbounded reference model and reports any divergence in
delivered output.  ``minimize_failing`` shrinks a failing schedule to
a minimal replayable one.
"""

from __future__ import annotations

from .engine import DeliveryEngine
from .frames import Frame
from .log import DurableLog
from .receiver import AMBIGUOUS, BUSY
from .refmodel import ReferenceModel

RETRYABLE = (BUSY, AMBIGUOUS)


def run_schedule(schedule, mod, window, capacity=None, prefix=()):
    """Run a schedule through the engine. Returns (outputs, engine, parked)."""
    engine = DeliveryEngine(mod=mod, window=window, capacity=capacity,
                            log=DurableLog(None))
    outputs = []
    parked = []

    def pump():
        progressed = True
        while progressed:
            progressed = False
            new = engine.poll()
            if new:
                outputs.extend(new)
                progressed = True
            if parked:
                still = []
                for f in parked:
                    status = engine.offer(f)["status"]
                    if status in RETRYABLE:
                        still.append(f)
                    else:
                        progressed = True
                if len(still) != len(parked):
                    parked[:] = still

    for frame in list(prefix) + list(schedule):
        frame = _as_frame(frame)
        status = engine.offer(frame)["status"]
        if status in RETRYABLE:
            parked.append(frame)
        pump()
    for _ in range(2 * len(parked) + 4):
        if not parked:
            break
        before = (len(parked), len(outputs))
        pump()
        if (len(parked), len(outputs)) == before:
            break
    return outputs, engine, list(parked)


def compare(schedule, mod, window, capacity=None, prefix=()):
    """Cross-check engine output against the reference model."""
    outputs, _engine, _parked = run_schedule(schedule, mod, window, capacity,
                                             prefix)
    ref = ReferenceModel(mod)
    for frame in list(prefix) + list(schedule):
        ref.offer(_as_frame(frame))
    ref_delivered = ref.delivered()
    eng_grouped = {}
    for rec in outputs:
        eng_grouped.setdefault((rec["stream"], rec["epoch"]), []).append(
            {k: rec[k] for k in ("seq", "content", "hash", "close")}
        )
    mismatches = []
    keys = sorted(set(ref_delivered) | set(eng_grouped))
    for key in keys:
        ref_recs = [
            {k: r[k] for k in ("seq", "content", "hash", "close")}
            for r in ref_delivered.get(key, [])
        ]
        eng_recs = eng_grouped.get(key, [])
        if ref_recs != eng_recs:
            mismatches.append({
                "stream": key[0],
                "epoch": key[1],
                "engine": eng_recs,
                "reference": ref_recs,
            })
    return mismatches


def minimize_failing(schedule, is_failing):
    """Greedy 1-minimality: remove frames while the schedule still fails."""
    sched = list(schedule)
    changed = True
    while changed:
        changed = False
        for i in range(len(sched)):
            candidate = sched[:i] + sched[i + 1:]
            if candidate and is_failing(candidate):
                sched = candidate
                changed = True
                break
    return sched


def replay_file(path, mod=None, window=None, capacity=None):
    """Replay a recorded JSON schedule; returns the delivered outputs."""
    import json

    with open(path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    mod = mod if mod is not None else doc["mod"]
    window = window if window is not None else doc["window"]
    capacity = capacity if capacity is not None else doc.get("capacity")
    prefix = [Frame.from_dict(d) for d in doc.get("prefix", [])]
    schedule = [Frame.from_dict(d) for d in doc["schedule"]]
    outputs, _engine, parked = run_schedule(schedule, mod, window, capacity,
                                            prefix)
    return {"outputs": outputs, "parked": [f.to_dict() for f in parked]}


def _as_frame(frame):
    return Frame.from_dict(frame) if isinstance(frame, dict) else frame
