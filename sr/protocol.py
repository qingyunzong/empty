"""Selective Repeat (SR) protocol core: sender, receiver, per-frame timers.

Constraint argument (why N <= seq_space / 2):
    The receiver window covers N sequence numbers starting at rcv_base, and
    the sender window covers N sequence numbers starting at base.  After the
    receiver slides its window forward by up to N positions, old ACKs (or
    retransmitted frames) carrying sequence numbers from the *previous*
    window position may still be in flight.  For the receiver to
    unambiguously distinguish "new frame inside the current window" from
    "duplicate of an already delivered frame", the current window
    [rcv_base, rcv_base + N) and the duplicate region
    [rcv_base - N, rcv_base) must not overlap modulo the sequence space M.
    That requires 2N <= M, i.e. N <= M / 2.  With N = 4 and M = 8 the
    invariant holds exactly; N = 5 with M = 8 would let a duplicate of an
    old frame alias onto a not-yet-received sequence number, so the
    constructor rejects it with ValueError.
"""

from dataclasses import dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class Frame:
    seq: int          # wire sequence number (mod seq_space)
    data: Any
    abs_seq: int      # absolute sequence number (simulation bookkeeping)


@dataclass(frozen=True)
class Ack:
    seq: int          # wire sequence number being acknowledged


def validate_params(window_size: int, seq_space: int) -> None:
    """Enforce the SR correctness constraint N <= seq_space / 2."""
    if not isinstance(window_size, int) or isinstance(window_size, bool):
        raise ValueError(f"window size must be an int, got {window_size!r}")
    if not isinstance(seq_space, int) or isinstance(seq_space, bool):
        raise ValueError(f"sequence space must be an int, got {seq_space!r}")
    if window_size < 1:
        raise ValueError(f"window size N must be >= 1, got {window_size}")
    if seq_space < 2:
        raise ValueError(f"sequence space must be >= 2, got {seq_space}")
    if window_size > seq_space // 2:
        raise ValueError(
            f"invalid SR parameters: window size N={window_size} exceeds half "
            f"the sequence space M={seq_space} (require N <= M/2, i.e. "
            f"N <= {seq_space // 2}); otherwise new frames and duplicates "
            f"alias modulo M and cannot be distinguished"
        )


class Sender:
    """SR sender: one independent virtual timer per outstanding frame."""

    def __init__(self, window_size: int = 4, seq_space: int = 8, timeout: int = 10):
        validate_params(window_size, seq_space)
        if timeout <= 0:
            raise ValueError(f"timeout must be positive, got {timeout}")
        self.window_size = window_size
        self.seq_space = seq_space
        self.timeout = timeout
        self.base = 0                 # absolute seq of window lower edge
        self.next_seq = 0             # next absolute seq to assign
        self.buffer = {}              # abs seq -> data (sent, not yet acked)
        self.acked = set()            # abs seqs acked but window not slid past
        self.timers = {}              # abs seq -> absolute expiry time
        self.retransmissions = 0
        self.timeout_log = []         # abs seqs in the order timers fired

    def window_full(self) -> bool:
        return self.next_seq >= self.base + self.window_size

    def send(self, data: Any, now: int) -> Frame:
        if self.window_full():
            raise RuntimeError(
                f"send window full: base={self.base} next={self.next_seq} "
                f"N={self.window_size}"
            )
        seq = self.next_seq
        self.next_seq += 1
        self.buffer[seq] = data
        self.timers[seq] = now + self.timeout   # independent per-frame timer
        return Frame(seq=seq % self.seq_space, data=data, abs_seq=seq)

    def receive_ack(self, wire_seq: int, now: int) -> bool:
        """Process an ACK.  The window slides only when its lower edge (base)
        is acknowledged; other ACKs merely mark the frame and cancel its timer.
        Returns True if the ACK matched an outstanding frame."""
        target = None
        upper = min(self.next_seq, self.base + self.window_size)
        for cand in range(self.base, upper):
            if cand % self.seq_space == wire_seq:
                target = cand
                break
        if target is None:
            return False  # stale or unknown ACK: ignore
        if target in self.acked:
            return True   # duplicate ACK
        self.acked.add(target)
        self.timers.pop(target, None)
        if target == self.base:
            # lower edge acknowledged: slide past every contiguous acked frame
            while self.base in self.acked:
                self.acked.discard(self.base)
                self.buffer.pop(self.base, None)
                self.timers.pop(self.base, None)
                self.base += 1
        return True

    def fire_timeout(self, abs_seq: int, now: int) -> Frame:
        """Timer for exactly one frame expired: retransmit only that frame."""
        data = self.buffer[abs_seq]
        self.timers[abs_seq] = now + self.timeout  # restart this frame's timer
        self.retransmissions += 1
        self.timeout_log.append(abs_seq)
        return Frame(seq=abs_seq % self.seq_space, data=data, abs_seq=abs_seq)


class Receiver:
    """SR receiver: buffers out-of-order frames, ACKs each frame
    individually, delivers to the upper layer strictly in order."""

    def __init__(self, window_size: int = 4, seq_space: int = 8):
        validate_params(window_size, seq_space)
        self.window_size = window_size
        self.seq_space = seq_space
        self.rcv_base = 0             # absolute seq of next expected frame
        self.buffer = {}              # abs seq -> data (received out of order)
        self.delivered = []           # in-order delivery log

    def receive(self, frame: Frame) -> Optional[Ack]:
        """Classify the arriving frame modulo seq_space:

        - offset in [0, N):        inside receive window -> buffer, ACK,
                                   deliver every contiguous frame from rcv_base
        - offset in [M-N, M):      duplicate of an already delivered frame ->
                                   re-send ACK, never deliver again
        - otherwise:               outside the window -> drop silently
        """
        m = self.seq_space
        n = self.window_size
        offset = (frame.seq - self.rcv_base % m) % m
        if offset < n:
            abs_seq = self.rcv_base + offset
            if abs_seq not in self.buffer:
                self.buffer[abs_seq] = frame.data
            while self.rcv_base in self.buffer:
                self.delivered.append(self.buffer.pop(self.rcv_base))
                self.rcv_base += 1
            return Ack(seq=frame.seq)
        if offset >= m - n:
            return Ack(seq=frame.seq)  # duplicate: re-ACK, do not deliver
        return None                    # out of window: drop
