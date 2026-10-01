"""Per-(stream, epoch) reassembly buffer with windowed flow control."""

from __future__ import annotations

from . import seqnum

ACCEPTED = "accepted"
DUPLICATE = "duplicate"
OLD = "old"                # unambiguously in the past
AMBIGUOUS = "ambiguous"    # outside the valid comparison window
BUSY = "busy"              # window full: deterministic backpressure
CONFLICT = "conflict"      # same seq, different content: atomically rejected
CLOSED = "closed"          # stream already closed
INVALID = "invalid"        # malformed frame


class AcceptResult:
    def __init__(self, status, **detail):
        self.status = status
        self.detail = detail

    def to_dict(self):
        out = {"status": self.status}
        out.update(self.detail)
        return out

    def __repr__(self):
        return f"AcceptResult({self.to_dict()!r})"


class Assembly:
    """Fragments of one message.

    The first fragment pins the content hash; any later fragment
    disagreeing with it is a conflict and mutates nothing.
    """

    __slots__ = ("frags_total", "hash", "close", "parts", "complete")

    def __init__(self, frags_total, hash_, close):
        self.frags_total = frags_total
        self.hash = hash_
        self.close = close
        self.parts = {}
        self.complete = False

    def add(self, frame):
        """Returns 'ok', 'duplicate' or 'conflict'. Never mutates on conflict."""
        if (
            frame.hash != self.hash
            or frame.frags != self.frags_total
            or frame.close != self.close
            or not (0 <= frame.frag < self.frags_total)
        ):
            return "conflict"
        if frame.frag in self.parts:
            if self.parts[frame.frag] != frame.payload:
                return "conflict"
            return "duplicate"
        self.parts[frame.frag] = frame.payload
        if len(self.parts) == self.frags_total:
            self.complete = True
        return "ok"

    def content(self):
        return "".join(self.parts[i] for i in range(self.frags_total))


class ReassemblyBuffer:
    def __init__(self, stream, epoch, mod, window, capacity=None):
        seqnum.check_window_params(mod, window)
        if capacity is None:
            capacity = window
        if not (0 < capacity <= window):
            raise ValueError("need 0 < capacity <= window")
        self.stream = stream
        self.epoch = epoch
        self.mod = mod
        self.window = window
        self.capacity = capacity  # max out-of-order messages buffered
        self.next_seq = 0            # next sequence number to deliver (cyclic)
        self.delivered_count = 0     # absolute delivery cursor inside the epoch
        self.slots = {}              # seq -> Assembly (window occupancy)
        self.received_abs = set()    # absolute indices of fully received messages
        self.delivered_hashes = {}   # seq -> hash of recently delivered messages
        self.closed = False
        self.evidence = []           # retained conflict evidence

    def _classify(self, seq):
        return seqnum.classify(seq, self.next_seq, self.mod, self.window)

    def _abs_index(self, seq):
        return self.delivered_count + seqnum.fwd_dist(self.next_seq, seq, self.mod)

    def accept(self, frame):
        if frame.stream != self.stream or frame.epoch != self.epoch:
            return AcceptResult(INVALID, reason="wrong stream/epoch")
        if frame.frags < 1 or not (0 <= frame.frag < frame.frags):
            return AcceptResult(INVALID, reason="bad fragment coordinates")
        if self.closed:
            return AcceptResult(CLOSED, reason="stream closed", seq=frame.seq)

        cls = self._classify(frame.seq)
        if cls == seqnum.PAST:
            kept = self.delivered_hashes.get(frame.seq)
            if kept is not None and kept != frame.hash:
                ev = self._evidence(frame, kept_hash=kept, kept_payload=None)
                return AcceptResult(CONFLICT, **ev)
            return AcceptResult(OLD, seq=frame.seq, next_seq=self.next_seq)
        if cls == seqnum.AMBIGUOUS:
            return AcceptResult(AMBIGUOUS, seq=frame.seq, next_seq=self.next_seq)

        asm = self.slots.get(frame.seq)
        if asm is None:
            if len(self.slots) >= self.capacity and frame.seq != self.next_seq:
                # Deterministic backpressure: the decision depends only on
                # current state, and no acknowledged data is ever evicted.
                # The head-of-line gap frame (seq == next_seq) is always
                # admissible so a full window can never deadlock.
                return AcceptResult(
                    BUSY,
                    seq=frame.seq,
                    capacity=self.capacity,
                    buffered=sorted(self.slots),
                )
            asm = Assembly(frame.frags, frame.hash, frame.close)
            verdict = asm.add(frame)
            if verdict == "conflict":  # unreachable after validation, be safe
                return AcceptResult(INVALID, reason="inconsistent frame")
            self.slots[frame.seq] = asm
            if asm.complete:
                self.received_abs.add(self._abs_index(frame.seq))
            return AcceptResult(ACCEPTED, seq=frame.seq, assembled=asm.complete)

        verdict = asm.add(frame)
        if verdict == "conflict":
            ev = self._evidence(
                frame, kept_hash=asm.hash, kept_payload=asm.parts.get(frame.frag)
            )
            return AcceptResult(CONFLICT, **ev)
        if verdict == "duplicate":
            return AcceptResult(DUPLICATE, seq=frame.seq)
        if asm.complete:
            self.received_abs.add(self._abs_index(frame.seq))
        return AcceptResult(ACCEPTED, seq=frame.seq, assembled=asm.complete)

    def _evidence(self, frame, kept_hash, kept_payload):
        ev = {
            "stream": self.stream,
            "epoch": self.epoch,
            "seq": frame.seq,
            "frag": frame.frag,
            "kept_hash": kept_hash,
            "rejected_hash": frame.hash,
            "kept_payload": kept_payload,
            "rejected_payload": frame.payload,
        }
        self.evidence.append(ev)
        return ev

    def poll_ready(self):
        """Pop contiguous complete messages starting at next_seq."""
        out = []
        while True:
            asm = self.slots.get(self.next_seq)
            if asm is None or not asm.complete:
                break
            del self.slots[self.next_seq]
            seq = self.next_seq
            out.append((seq, asm.content(), asm.hash, asm.close))
            self.next_seq = (self.next_seq + 1) % self.mod
            self.delivered_count += 1
            self._remember_delivered(seq, asm.hash)
            if asm.close:
                self.closed = True
                break
        return out

    def _remember_delivered(self, seq, hash_):
        self.delivered_hashes[seq] = hash_
        keep = set()
        for s in self.delivered_hashes:
            d = (s - self.next_seq) % self.mod
            if d >= self.mod - self.window:
                keep.add(s)
        self.delivered_hashes = {
            s: h for s, h in self.delivered_hashes.items() if s in keep
        }

    def acks(self):
        """Selective ack ranges and gap retransmit requests.

        Ranges and gaps are offsets relative to ``next_seq``; only offsets
        inside the valid comparison window are reported, so no cyclic
        number is ever compared outside its valid window.
        """
        offsets = sorted(
            a - self.delivered_count
            for a in self.received_abs
            if -self.window <= a - self.delivered_count < self.window
        )
        ranges = []
        for off in offsets:
            if ranges and off == ranges[-1][1] + 1:
                ranges[-1][1] = off
            else:
                ranges.append([off, off])
        gaps = []
        if offsets:
            have = set(offsets)
            for off in range(0, offsets[-1] + 1):
                if off in have:
                    continue
                if gaps and off == gaps[-1][1] + 1:
                    gaps[-1][1] = off
                else:
                    gaps.append([off, off])
        retransmit = [
            (self.next_seq + off) % self.mod
            for start, end in gaps
            for off in range(start, end + 1)
        ]
        return {
            "stream": self.stream,
            "epoch": self.epoch,
            "next_seq": self.next_seq,
            "delivered": self.delivered_count,
            "closed": self.closed,
            "ack_ranges": ranges,
            "gap_ranges": gaps,
            "retransmit": retransmit,
        }
