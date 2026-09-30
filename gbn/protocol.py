"""Go-Back-N protocol entities: sender and receiver.

Window N = 4, sequence number space = 8. All sequence number
comparisons are done with modular arithmetic so that wrap-around
(7 -> 0) is handled correctly.
"""

WINDOW_SIZE = 4
SEQ_SPACE = 8


def seq_distance(seq, base, space=SEQ_SPACE):
    """Forward distance from ``base`` to ``seq`` in the modular space."""
    return (seq - base) % space


def in_window(seq, base, size=WINDOW_SIZE, space=SEQ_SPACE):
    """True if ``seq`` lies in ``[base, base + size)`` (mod ``space``)."""
    return (seq - base) % space < size


class Frame:
    """A data frame queued by the sender for transmission."""

    __slots__ = ("kind", "seq", "payload", "retransmit")

    def __init__(self, kind, seq, payload=None, retransmit=False):
        self.kind = kind
        self.seq = seq
        self.payload = payload
        self.retransmit = retransmit


class Sender:
    """GBN sender with a single timer for the oldest unacknowledged frame."""

    def __init__(self, window=WINDOW_SIZE, space=SEQ_SPACE, timeout=10):
        if not 0 < window < space:
            raise ValueError("window must be in (0, seq_space)")
        self.window = window
        self.space = space
        self.timeout = timeout
        self.base = 0
        self.next_seq = 0
        self.buffer = {}
        self.timer_deadline = None
        self._pending = []

    def outstanding(self):
        """Number of unacknowledged frames in the window."""
        return (self.next_seq - self.base) % self.space

    def window_full(self):
        return self.outstanding() >= self.window

    def send(self, payload, now):
        """Accept new data into the window.

        Returns False (never blocks) when the window is full.
        """
        if self.window_full():
            return False
        seq = self.next_seq
        self.buffer[seq] = payload
        self.next_seq = (self.next_seq + 1) % self.space
        self._pending.append(Frame("data", seq, payload))
        if self.timer_deadline is None:
            self.timer_deadline = now + self.timeout
        return True

    def on_ack(self, ack, now):
        """Handle a cumulative ACK; slide the window to ``ack + 1``.

        Returns a list of events. Stale/duplicate ACKs are ignored.
        Corrupt ACKs never reach this method (dropped by the simulator).
        """
        outstanding = self.outstanding()
        if outstanding == 0 or (ack - self.base) % self.space >= outstanding:
            return []
        self.base = (ack + 1) % self.space
        self.buffer = {
            seq: payload
            for seq, payload in self.buffer.items()
            if (seq - self.base) % self.space < self.outstanding()
        }
        if self.base == self.next_seq:
            self.timer_deadline = None
        else:
            self.timer_deadline = now + self.timeout
        return [("window-slide", self.base)]

    def timer_expired(self, tick):
        return self.timer_deadline is not None and tick >= self.timer_deadline

    def on_timeout(self, now):
        """Retransmit every unacknowledged frame in the window."""
        seq = self.base
        while seq != self.next_seq:
            self._pending.append(
                Frame("data", seq, self.buffer[seq], retransmit=True)
            )
            seq = (seq + 1) % self.space
        if self.base != self.next_seq:
            self.timer_deadline = now + self.timeout

    def drain_pending(self):
        pending, self._pending = self._pending, []
        return pending


class Receiver:
    """GBN receiver: accepts only the expected sequence number.

    Anything else (out-of-order or corrupt) is discarded and the last
    cumulative ACK is re-sent.
    """

    def __init__(self, space=SEQ_SPACE):
        self.space = space
        self.expected = 0
        self.last_acked = None
        self.delivered = []

    def on_data(self, seq, payload, corrupt=False):
        """Process an incoming data frame.

        Returns ``(delivered_payload_or_None, ack_to_send_or_None)``.
        """
        if not corrupt and seq == self.expected:
            self.delivered.append(payload)
            self.last_acked = seq
            self.expected = (self.expected + 1) % self.space
            return payload, seq
        return None, self.last_acked
