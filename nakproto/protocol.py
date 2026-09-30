"""NAK protocol simulation: sender, receiver and virtual-clock driver.

Tick model (virtual clock, ticks 0..N):
  1. Send phase    - the sender transmits the next new frame; the frame is
                     either lost (per script) or arrives this tick (plus an
                     optional per-frame delay).
  2. Arrival phase - the receiver processes, in order: the new frame of this
                     tick, delayed frames due this tick, then retransmissions.
  3. NAK phase     - for every still-open gap the receiver emits a NAK, unless
                     it already NAK'd that gap within the last `debounce`
                     ticks. The sender answers immediately: RETRANSMIT (frame
                     arrives next tick) or RANGE_ERR (frame slid out of the
                     sender ring buffer) which moves the receiver to FAILED.
"""

from __future__ import annotations

from collections import defaultdict

from .config import Config

RETRANSMIT = "RETRANSMIT"
RANGE_ERR = "RANGE_ERR"

_ARRIVAL_ORDER = {"NEW": 0, "DELAY": 1, "RETX": 2}


class Sender:
    """Sends frames and keeps the last `window` frames for retransmission."""

    def __init__(self, window: int = 8):
        self.window = window
        self.buffer: dict[int, int] = {}

    def send(self, seq: int) -> None:
        self.buffer[seq] = seq
        while len(self.buffer) > self.window:
            del self.buffer[min(self.buffer)]

    def handle_nak(self, seq: int) -> str:
        # Idempotent: duplicate NAKs for the same seq get the same answer and
        # do not disturb the ring buffer.
        if seq in self.buffer:
            return RETRANSMIT
        return RANGE_ERR


class Receiver:
    """Delivers frames strictly in order; NAKs gaps with debounce."""

    def __init__(self, first_seq: int, debounce: int = 20):
        self.expected = first_seq
        self.debounce = debounce
        self.buffer: dict[int, int] = {}
        self.delivered: list[int] = []
        self.last_nak: dict[int, int] = {}
        self.nak_log: list[dict] = []
        self.failed = False

    def on_frame(self, seq: int, tick: int, trace: list[dict]) -> None:
        if self.failed:
            return
        if seq < self.expected:
            trace.append({"tick": tick, "event": "DUP_DROP", "seq": seq})
            return
        if seq > self.expected:
            if seq in self.buffer:
                trace.append({"tick": tick, "event": "DUP_DROP", "seq": seq})
            else:
                self.buffer[seq] = seq
                trace.append({"tick": tick, "event": "BUFFER", "seq": seq})
            return
        self._deliver(seq, tick, trace)
        while self.expected in self.buffer:
            nxt = self.buffer.pop(self.expected)
            self._deliver(nxt, tick, trace)

    def _deliver(self, seq: int, tick: int, trace: list[dict]) -> None:
        self.delivered.append(seq)
        trace.append({"tick": tick, "event": "DELIVER", "seq": seq})
        self.expected += 1

    def open_gaps(self) -> list[int]:
        if not self.buffer:
            return []
        hi = max(self.buffer)
        return [s for s in range(self.expected, hi + 1) if s not in self.buffer]


def run_simulation(config: Config) -> dict:
    sender = Sender(config.window)
    receiver = Receiver(config.frames[0], config.debounce)
    pending: dict[int, list[tuple[str, int]]] = defaultdict(list)
    trace: list[dict] = []

    tick = 0
    status = "INCOMPLETE"
    while True:
        # 1. send phase
        if tick < len(config.frames):
            seq = config.frames[tick]
            sender.send(seq)
            trace.append({"tick": tick, "event": "SEND", "seq": seq})
            if seq in config.loss or seq in config.loss_permanent:
                trace.append({"tick": tick, "event": "LOSS", "seq": seq})
            else:
                arrive = tick + config.delay.get(seq, 0)
                kind = "NEW" if arrive == tick else "DELAY"
                pending[arrive].append((kind, seq))

        # 2. arrival phase
        due = pending.pop(tick, [])
        for kind, seq in sorted(due, key=lambda item: _ARRIVAL_ORDER[item[0]]):
            trace.append({"tick": tick, "event": "RECV", "seq": seq, "via": kind})
            receiver.on_frame(seq, tick, trace)

        # 3. NAK phase
        if not receiver.failed:
            for gap in receiver.open_gaps():
                last = receiver.last_nak.get(gap)
                if last is not None and tick - last < config.debounce:
                    continue
                receiver.last_nak[gap] = tick
                response = sender.handle_nak(gap)
                receiver.nak_log.append(
                    {"tick": tick, "seq": gap, "response": response}
                )
                trace.append(
                    {"tick": tick, "event": "NAK", "seq": gap, "response": response}
                )
                if response == RETRANSMIT:
                    if gap in config.loss_permanent:
                        trace.append({"tick": tick, "event": "RETX_LOSS", "seq": gap})
                    else:
                        pending[tick + 1].append(("RETX", gap))
                else:
                    receiver.failed = True
                    trace.append({"tick": tick, "event": "FAILED"})
                    break

        # termination
        if receiver.failed:
            status = "FAILED"
            break
        if tick >= len(config.frames) and not pending and not receiver.open_gaps():
            status = "OK" if receiver.delivered == config.frames else "INCOMPLETE"
            break
        if tick >= config.max_ticks:
            status = "INCOMPLETE"
            break
        tick += 1

    return {
        "status": status,
        "delivered": receiver.delivered,
        "nak_log": receiver.nak_log,
        "trace": trace,
    }
