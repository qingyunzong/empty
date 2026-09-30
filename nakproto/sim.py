"""NAK protocol simulation on a virtual tick clock.

Timing model (per tick t, in order):
  1. Arrivals scheduled for tick t are processed by the receiver
     (retransmissions / RANGE_ERR / duplicate copies scheduled earlier).
  2. The sender transmits new frame seq=t (if t <= frames). It is pushed
     into the sender ring buffer (last W=8 sent frames). Unless the script
     drops it, the receiver processes it in the same tick.
  3. NAKs emitted during receiver processing are answered by the sender
     immediately: RETX (frame retained in the ring buffer) or RANGE_ERR
     (frame slid out). The answer arrives at the receiver at tick t+1.

Receiver rules:
  - seq < expected: duplicate, dropped (never triggers a NAK).
  - seq == expected: deliver, then drain consecutively buffered frames.
  - seq > expected: buffer the frame (no delivery past the gap) and emit a
    NAK for every missing seq, debounced to at most one NAK per missing
    seq per NAK_DEBOUNCE=20 ticks.
  - RANGE_ERR: receiver enters FAILED and stops delivering (frozen).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from .script import Script

WINDOW = 8
NAK_DEBOUNCE = 20


class Sender:
    """Sender with a ring buffer retaining the last WINDOW sent frames."""

    def __init__(self, window: int = WINDOW) -> None:
        self.window = window
        self.latest_sent = 0
        self.retransmissions = 0
        self.range_errors = 0

    def send_new(self) -> int:
        self.latest_sent += 1
        return self.latest_sent

    def handle_nak(self, seq: int) -> str:
        """Answer a NAK. Idempotent: duplicate NAKs change no state beyond
        the (idempotent) retransmission counter decision."""
        if self.latest_sent - self.window < seq <= self.latest_sent:
            self.retransmissions += 1
            return "RETX"
        self.range_errors += 1
        return "RANGE_ERR"


class Receiver:
    """Receiver with gap detection, NAK debounce and in-order delivery."""

    def __init__(self, debounce: int = NAK_DEBOUNCE) -> None:
        self.debounce = debounce
        self.expected = 1
        self.buffer: dict[int, int] = {}
        self.last_nak: dict[int, int] = {}
        self.delivered: list[int] = []
        self.delivery_ticks: list[int] = []
        self.failed = False

    def _deliver(self, seq: int, tick: int) -> None:
        self.delivered.append(seq)
        self.delivery_ticks.append(tick)
        self.expected = seq + 1

    def receive(self, seq: int, tick: int) -> list[int]:
        """Process an arrived frame; return missing seqs to NAK now."""
        if self.failed:
            return []
        if seq < self.expected:
            return []  # duplicate / late copy: drop, never NAK
        if seq == self.expected:
            self._deliver(seq, tick)
            while self.expected in self.buffer:
                self._deliver(self.buffer.pop(self.expected), tick)
            return []
        self.buffer.setdefault(seq, seq)
        naks = []
        for missing in range(self.expected, seq):
            if missing in self.buffer:
                continue
            last = self.last_nak.get(missing)
            if last is None or tick - last >= self.debounce:
                self.last_nak[missing] = tick
                naks.append(missing)
        return naks

    def on_range_err(self) -> None:
        self.failed = True


@dataclass
class SimResult:
    state: str  # "OK" | "FAILED" | "INCOMPLETE"
    delivered: list[int]
    delivery_ticks: list[int]
    nak_log: list[dict]
    events: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "delivered": self.delivered,
            "delivery_ticks": self.delivery_ticks,
            "nak_log": self.nak_log,
            "events": self.events,
        }


def run_simulation(script: Script, window: int = WINDOW,
                   debounce: int = NAK_DEBOUNCE) -> SimResult:
    sender = Sender(window)
    receiver = Receiver(debounce)
    drop = set(script.drop)
    drop_retx = set(script.drop_retx)
    duplicate = set(script.duplicate)

    events: list[dict] = []
    nak_log: list[dict] = []
    pending: dict[int, list[tuple[str, int]]] = defaultdict(list)

    def emit(tick: int, kind: str, **detail: object) -> None:
        events.append({"tick": tick, "type": kind, **detail})

    def answer_naks(seqs: list[int], tick: int) -> None:
        for seq in seqs:
            nak_log.append({"tick": tick, "seq": seq})
            emit(tick, "nak", seq=seq)
            if sender.handle_nak(seq) == "RETX":
                if seq in drop_retx:
                    emit(tick, "retx_loss", seq=seq)
                else:
                    emit(tick, "retx", seq=seq, arrive=tick + 1)
                    pending[tick + 1].append(("frame", seq))
            else:
                emit(tick, "range_err", seq=seq, arrive=tick + 1)
                pending[tick + 1].append(("range_err", seq))

    max_tick = script.frames + 2 * debounce + window + 5
    tick = 1
    while tick <= max_tick:
        # Phase 1: scheduled arrivals.
        for kind, seq in pending.pop(tick, []):
            if kind == "range_err":
                if not receiver.failed:
                    emit(tick, "failed", seq=seq)
                    receiver.on_range_err()
            else:
                answer_naks(receiver.receive(seq, tick), tick)
        if receiver.failed:
            break
        # Phase 2: new send.
        if tick <= script.frames:
            seq = sender.send_new()
            if seq in drop:
                emit(tick, "loss", seq=seq)
            else:
                emit(tick, "send", seq=seq)
                answer_naks(receiver.receive(seq, tick), tick)
                if seq in duplicate:
                    pending[tick + 2].append(("frame", seq))
        if len(receiver.delivered) == script.frames:
            break
        tick += 1

    # Record deliveries into the event log for the reference timeline.
    delivery_events = [
        {"tick": t, "type": "deliver", "seq": s}
        for s, t in zip(receiver.delivered, receiver.delivery_ticks)
    ]
    events = sorted(events + delivery_events,
                    key=lambda e: (e["tick"], e["type"] != "deliver"))

    if receiver.failed:
        state = "FAILED"
    elif len(receiver.delivered) == script.frames:
        state = "OK"
    else:
        state = "INCOMPLETE"
    return SimResult(
        state=state,
        delivered=receiver.delivered,
        delivery_ticks=receiver.delivery_ticks,
        nak_log=nak_log,
        events=events,
    )
