"""Independent unbounded reference model used to cross-check the engine.

Structurally different from StreamReceiver on purpose: no incremental
window bookkeeping, no partial-eviction logic -- just an unbounded bag of
fragments plus a delivery cursor derived from the delivered count.  It
shares only the spec-level window arithmetic (seqnum.classify), because
frame *acceptance* is part of the protocol contract, not an
implementation detail.
"""
from __future__ import annotations

from .messages import CLOSE, Frame, hash_content
from .seqnum import Region, classify


class ReferenceReceiver:
    def __init__(self, stream_id: str, epoch: int, modulus: int, window: int,
                 base: int = 0):
        self.stream_id = stream_id
        self.epoch = epoch
        self.modulus = modulus
        self.window = window
        self.base = base % modulus
        self.delivered: list[dict] = []
        self.complete: dict[int, tuple[str, str]] = {}
        self.frags: dict[int, dict[int, str]] = {}
        self.meta: dict[int, tuple[int, str, str]] = {}
        self.done = False

    @property
    def next_expected(self) -> int:
        return (self.base + len(self.delivered)) % self.modulus

    def receive(self, frame: Frame) -> str:
        if self.done:
            return "closed"
        if classify(frame.seq, self.next_expected, self.window,
                    self.modulus) is not Region.CURRENT:
            return "rejected"
        if frame.seq in self.complete:
            return "dup"
        meta = (frame.frag_count, frame.content_hash, frame.kind)
        known = self.meta.get(frame.seq)
        if known is not None and known != meta:
            return "conflict"
        self.meta.setdefault(frame.seq, meta)
        slot = self.frags.setdefault(frame.seq, {})
        if slot.get(frame.frag_index, frame.payload) != frame.payload:
            return "conflict"
        slot[frame.frag_index] = frame.payload
        if len(slot) < frame.frag_count:
            return "ack"
        content = "".join(slot[i] for i in range(frame.frag_count))
        if hash_content(content) != frame.content_hash:
            # Same atomic-reject-and-allow-retry contract as the engine.
            del self.frags[frame.seq]
            del self.meta[frame.seq]
            return "conflict"
        self.complete[frame.seq] = (frame.kind, content)
        del self.frags[frame.seq]
        del self.meta[frame.seq]
        return "complete"

    def poll(self) -> list[dict]:
        out = []
        while self.next_expected in self.complete:
            kind, content = self.complete.pop(self.next_expected)
            record = {"stream_id": self.stream_id, "epoch": self.epoch,
                      "seq": self.next_expected, "kind": kind,
                      "content": content}
            self.delivered.append(record)
            out.append(record)
            if kind == CLOSE:
                self.done = True
        return out

    def crash(self) -> None:
        """Same durability contract as the engine: only assembled (acked)
        messages survive a crash; unacked partial fragments are volatile
        and will be retransmitted by the peer."""
        self.frags = {}
        self.meta = {}


class ReferenceModel:
    """Unbounded multi-stream counterpart of Engine."""

    def __init__(self, modulus: int, window: int):
        self.modulus = modulus
        self.window = window
        self.receivers: dict[tuple[str, int], ReferenceReceiver] = {}

    def receive(self, frame: Frame) -> str:
        key = (frame.stream_id, frame.epoch)
        receiver = self.receivers.get(key)
        if receiver is None:
            receiver = ReferenceReceiver(frame.stream_id, frame.epoch,
                                         self.modulus, self.window)
            self.receivers[key] = receiver
        return receiver.receive(frame)

    def poll(self) -> list[dict]:
        out = []
        for key in sorted(self.receivers):
            out.extend(self.receivers[key].poll())
        return out

    def crash(self) -> None:
        for receiver in self.receivers.values():
            receiver.crash()
