"""Ordered-delivery receiver for one (stream_id, epoch) channel.

Bounded memory: at most ``window`` sequence slots are live at any time.
Acknowledgement happens exactly once per message, at the assemble commit
point, so the persistent ack set is always consistent with what a crash
recovery will rebuild.  Acknowledged-but-undelivered data is never
dropped; a full window produces deterministic BACKPRESSURE rejections of
out-of-window frames instead.
"""
from __future__ import annotations

import enum
from dataclasses import dataclass, field

from .messages import CLOSE, DATA, Frame, hash_content
from .seqnum import Region, check_window, classify, forward_distance


class Status(enum.Enum):
    ACK = "ack"                    # fragment stored, message still incomplete
    COMPLETE = "complete"          # this frame completed a message (acked)
    DUP = "dup"                    # already acknowledged (persistent dedup)
    OLD = "old"                    # behind the receive window
    FUTURE = "future"              # beyond the receive window, rejected
    BACKPRESSURE = "backpressure"  # window full: deterministic rejection
    CONFLICT = "conflict"          # same seq, different content: rejected atomically
    INVALID = "invalid"            # malformed fragment coordinates
    CLOSED = "closed"              # stream already closed and drained


@dataclass
class ReceiveResult:
    status: Status
    events: list = field(default_factory=list)   # journal records to commit
    evidence: dict | None = None                 # kept on CONFLICT


@dataclass
class _Partial:
    frag_count: int
    content_hash: str
    kind: str
    frags: dict = field(default_factory=dict)  # frag_index -> payload
    first_frame: dict | None = None


class StreamReceiver:
    def __init__(self, stream_id: str, epoch: int, modulus: int, window: int,
                 base: int = 0):
        check_window(window, modulus)
        self.stream_id = stream_id
        self.epoch = epoch
        self.modulus = modulus
        self.window = window
        self.next_expected = base % modulus
        self.partials: dict[int, _Partial] = {}
        self.acked: set[int] = set()          # persistent ack set (assembled seqs)
        self.ready: dict[int, tuple[str, str]] = {}  # assembled, undelivered
        self.close_seq: int | None = None
        self.done = False                     # close delivered to the business
        self.conflicts: list[dict] = []       # retained conflict evidence
        self.delivered_seqs: list[int] = []   # output cursor trail

    # ------------------------------------------------------------------ window
    def _in_window(self, seq: int) -> bool:
        return classify(seq, self.next_expected, self.window,
                        self.modulus) is Region.CURRENT

    def _occupied(self) -> set[int]:
        return {s for s in set(self.partials) | set(self.ready) if self._in_window(s)}

    def window_full(self) -> bool:
        return len(self._occupied()) >= self.window

    # ----------------------------------------------------------------- receive
    def receive(self, frame: Frame) -> ReceiveResult:
        if frame.stream_id != self.stream_id or frame.epoch != self.epoch:
            raise ValueError("misrouted frame")
        if self.done:
            return ReceiveResult(Status.CLOSED)
        region = classify(frame.seq, self.next_expected, self.window, self.modulus)
        if region is Region.OLD:
            return ReceiveResult(Status.OLD)
        if region is Region.FUTURE:
            # Deterministic backpressure: same state + same frame -> same answer.
            status = Status.BACKPRESSURE if self.window_full() else Status.FUTURE
            return ReceiveResult(status)
        if frame.seq in self.acked:
            return ReceiveResult(Status.DUP)
        if not 0 <= frame.frag_index < frame.frag_count:
            return ReceiveResult(Status.INVALID)

        partial = self.partials.get(frame.seq)
        if partial is not None and (
            partial.frag_count != frame.frag_count
            or partial.content_hash != frame.content_hash
            or partial.kind != frame.kind
        ):
            evidence = self._record_conflict(frame, partial)
            return ReceiveResult(Status.CONFLICT, [("conflict", evidence)], evidence)
        if partial is None:
            partial = _Partial(frame.frag_count, frame.content_hash, frame.kind,
                               first_frame=frame.to_dict())
            self.partials[frame.seq] = partial
        if frame.frag_index in partial.frags:
            if partial.frags[frame.frag_index] != frame.payload:
                evidence = self._record_conflict(frame, partial)
                return ReceiveResult(Status.CONFLICT, [("conflict", evidence)], evidence)
            return ReceiveResult(Status.DUP)  # identical retransmitted fragment

        partial.frags[frame.frag_index] = frame.payload
        if len(partial.frags) < partial.frag_count:
            return ReceiveResult(Status.ACK)

        content = "".join(partial.frags[i] for i in range(partial.frag_count))
        if hash_content(content) != partial.content_hash:
            # Corrupted assembly: reject atomically, keep evidence, allow retry.
            evidence = self._record_conflict(frame, partial)
            del self.partials[frame.seq]
            return ReceiveResult(Status.CONFLICT, [("conflict", evidence)], evidence)

        del self.partials[frame.seq]
        self.acked.add(frame.seq)
        self.ready[frame.seq] = (partial.kind, content)
        if partial.kind == CLOSE:
            self.close_seq = frame.seq
        event = ("assembled", {
            "stream_id": self.stream_id, "epoch": self.epoch, "seq": frame.seq,
            "kind": partial.kind, "content": content,
            "content_hash": partial.content_hash,
        })
        return ReceiveResult(Status.COMPLETE, [event])

    def _record_conflict(self, frame: Frame, partial: _Partial) -> dict:
        evidence = {
            "stream_id": self.stream_id,
            "epoch": self.epoch,
            "seq": frame.seq,
            "kept_hash": partial.content_hash,
            "rejected_hash": frame.content_hash,
            "kept_frags": dict(partial.frags),
            "kept_first_frame": partial.first_frame,
            "rejected_frame": frame.to_dict(),
        }
        self.conflicts.append(evidence)
        return evidence

    # ----------------------------------------------------------------- deliver
    def poll(self, max_n: int | None = None) -> tuple[list[dict], list]:
        """Deliver assembled messages in order; returns (deliveries, events)."""
        deliveries, events = [], []
        while self.next_expected in self.ready:
            if max_n is not None and len(deliveries) >= max_n:
                break
            kind, content = self.ready.pop(self.next_expected)
            seq = self.next_expected
            record = {"stream_id": self.stream_id, "epoch": self.epoch,
                      "seq": seq, "kind": kind, "content": content}
            events.append(("delivered", record))
            deliveries.append(dict(record))
            self.delivered_seqs.append(seq)
            self.next_expected = (self.next_expected + 1) % self.modulus
            if kind == CLOSE:
                self.done = True
        self._prune_acked()
        return deliveries, events

    def _prune_acked(self) -> None:
        """Bounded memory: the ack set only covers the live window.

        Seqs that fell behind the window are classified OLD on arrival, so
        keeping them in the ack set is unnecessary -- and wrong, because a
        recycled seq from the next cycle must not dedup against its
        previous incarnation.
        """
        self.acked = {s for s in self.acked if self._in_window(s)}
    # --------------------------------------------------------------------- ack
    def ack_ranges(self) -> list[tuple[int, int]]:
        """Selective ack intervals over the live window, cyclic-order aware."""
        seqs = sorted((s for s in self.acked if self._in_window(s)),
                      key=lambda s: forward_distance(self.next_expected, s,
                                                     self.modulus))
        ranges: list[list[int]] = []
        for seq in seqs:
            if ranges and seq == (ranges[-1][1] + 1) % self.modulus:
                ranges[-1][1] = seq
            else:
                ranges.append([seq, seq])
        return [tuple(r) for r in ranges]

    def gap_requests(self) -> list[int]:
        """Missing seqs below the furthest ack: selective retransmit request."""
        live = [s for s in self.acked if self._in_window(s)]
        if not live:
            return []
        furthest = max(forward_distance(self.next_expected, s, self.modulus)
                       for s in live)
        return [(self.next_expected + k) % self.modulus
                for k in range(furthest + 1)
                if (self.next_expected + k) % self.modulus not in self.acked]

    # ----------------------------------------------------------------- restore
    def _restore(self, *, acked, ready, next_expected, close_seq, done,
                 conflicts, delivered_seqs) -> None:
        self.acked = set(acked)
        self.ready = dict(ready)
        self.next_expected = next_expected
        self.close_seq = close_seq
        self.done = done
        self.conflicts = list(conflicts)
        self.delivered_seqs = list(delivered_seqs)
