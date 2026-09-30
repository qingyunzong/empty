"""Event-driven GBN simulation on a virtual clock.

Each tick, in order:
  1. deliver every packet whose arrival tick has been reached,
  2. fire the sender timer if it expired (retransmit the window),
  3. let the sender fill its window with new frames,
  4. flush queued frames into the channel.
"""

import json

from .channel import Channel, InjectionRule, Packet
from .protocol import Receiver, Sender


class Result:
    def __init__(self, delivered, events, ticks):
        self.delivered = delivered
        self.events = events
        self.ticks = ticks


class Simulator:
    def __init__(self, frames, timeout=10, rules=None, max_ticks=10000):
        self.frames = list(frames)
        self.sender = Sender(timeout=timeout)
        self.receiver = Receiver()
        self.channel = Channel(rules or [])
        self.max_ticks = max_ticks
        self.events = []

    def run(self):
        idx = 0
        total = len(self.frames)
        for tick in range(self.max_ticks):
            self._deliver(tick)
            self._check_timeout(tick)
            self._flush_pending(tick)
            idx = self._send_new(idx, tick)
            if len(self.receiver.delivered) == total:
                return Result(self.receiver.delivered, self.events, tick)
            if self._stalled(idx):
                raise RuntimeError("simulation stalled: no progress possible")
        raise RuntimeError(
            f"simulation did not finish within {self.max_ticks} ticks"
        )

    def _deliver(self, tick):
        for pkt in self.channel.due(tick):
            if pkt.kind == "data":
                self.events.append(("recv-data", pkt.seq))
                if pkt.corrupt:
                    self.events.append(("corrupt-data", pkt.seq))
                delivered, ack = self.receiver.on_data(
                    pkt.seq, pkt.payload, pkt.corrupt
                )
                if delivered is not None:
                    self.events.append(("deliver", pkt.seq))
                else:
                    self.events.append(("discard", pkt.seq))
                if ack is not None:
                    self.events.append(("send-ack", ack))
                    self.events.append(("transmit", "ack", ack))
                    self.events.extend(
                        self.channel.transmit(Packet("ack", ack), tick)
                    )
            else:
                if pkt.corrupt:
                    self.events.append(("corrupt-ack", pkt.seq))
                    continue
                self.events.append(("recv-ack", pkt.seq))
                self.events.extend(self.sender.on_ack(pkt.seq, tick))

    def _check_timeout(self, tick):
        if self.sender.timer_expired(tick):
            self.events.append(("timeout", self.sender.base))
            self.sender.on_timeout(tick)

    def _send_new(self, idx, tick):
        while idx < len(self.frames):
            seq = self.sender.next_seq
            if not self.sender.send(self.frames[idx], tick):
                break
            self.events.append(("send", seq))
            idx += 1
            self._flush_pending(tick)
        return idx

    def _flush_pending(self, tick):
        for frame in self.sender.drain_pending():
            if frame.retransmit:
                self.events.append(("retransmit", frame.seq))
            self.events.append(("transmit", frame.kind, frame.seq))
            packet = Packet(frame.kind, frame.seq, frame.payload)
            self.events.extend(self.channel.transmit(packet, tick))

    def _stalled(self, idx):
        return (
            not self.channel.transit
            and not self.sender._pending
            and self.sender.timer_deadline is None
        )


def load_trace(path):
    """Load a trace script (JSON) into simulator kwargs."""
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    frames = raw.get("frames", 0)
    if isinstance(frames, int):
        frames = list(range(frames))
    rules = [
        InjectionRule(
            action=e["action"],
            kind=e["kind"],
            seq=e["seq"],
            occurrence=e.get("occurrence", 1),
            by=e.get("by", 0),
        )
        for e in raw.get("events", [])
    ]
    return {
        "frames": frames,
        "timeout": raw.get("timeout", 10),
        "rules": rules,
        "max_ticks": raw.get("max_ticks", 10000),
    }


def run_trace(trace):
    return Simulator(
        trace["frames"],
        timeout=trace["timeout"],
        rules=trace["rules"],
        max_ticks=trace["max_ticks"],
    ).run()
