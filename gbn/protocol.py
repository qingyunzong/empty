"""Go-Back-N (GBN) protocol entities: sender and receiver.

Window N = 4, sequence number space = 8 by default. All sequence number
arithmetic is modular; comparisons are done via modular distance so that
wrap-around (7 -> 0) is handled correctly.
"""

WINDOW_SIZE = 4
SEQ_SPACE = 8


def seq_distance(start, end, space=SEQ_SPACE):
    """Modular distance from ``start`` to ``end`` in the sequence space."""
    return (end - start) % space


class Sender:
    """GBN sender.

    - ``send()`` is non-blocking: returns False when the window is full.
    - A cumulative ACK k slides the window base to k + 1.
    - Only the oldest unacknowledged frame owns a timer; on timeout every
      unacknowledged frame in the window is retransmitted.
    """

    def __init__(self, env, channel, window=WINDOW_SIZE, space=SEQ_SPACE,
                 timeout=10):
        if window * 2 > space:
            raise ValueError("window must be <= half the sequence space")
        self.env = env
        self.channel = channel
        self.window = window
        self.space = space
        self.timeout = timeout
        self.base = 0
        self.next_seq = 0
        self.buffer = {}
        self.timer_active = False
        self._timer_version = 0

    # -- application interface ------------------------------------------------
    def send(self, data):
        """Buffer and transmit a payload; False (non-blocking) if window full."""
        if seq_distance(self.base, self.next_seq, self.space) >= self.window:
            self.env.log("send_rejected", data)
            return False
        seq = self.next_seq
        self.buffer[seq] = data
        self.next_seq = (self.next_seq + 1) % self.space
        self.env.log("app_send", data, seq)
        if not self.timer_active:
            self._start_timer()
        self._transmit(seq)
        return True

    # -- network interface ----------------------------------------------------
    def receive_ack(self, ack, corrupted=False):
        """Handle a cumulative ACK; corrupted ACKs never slide the window."""
        if corrupted:
            self.env.log("ignore_corrupt_ack", ack)
            return
        outstanding = seq_distance(self.base, self.next_seq, self.space)
        if outstanding == 0 or \
                seq_distance(self.base, ack, self.space) >= outstanding:
            # Duplicate or out-of-window ACK: does not advance the window.
            self.env.log("ignore_ack", ack)
            return
        self.env.log("rx_ack", ack)
        new_base = (ack + 1) % self.space
        seq = self.base
        while seq != new_base:
            self.buffer.pop(seq, None)
            seq = (seq + 1) % self.space
        self.base = new_base
        self.env.log("slide", self.base)
        if self.base == self.next_seq:
            self._stop_timer()
        else:
            self._start_timer()

    # -- timer (only the oldest unacknowledged frame is timed) -----------------
    def _start_timer(self):
        self._timer_version += 1
        self.timer_active = True
        version = self._timer_version

        def on_timeout():
            if self.timer_active and self._timer_version == version:
                self._on_timeout()

        self.env.schedule(self.timeout, on_timeout)

    def _stop_timer(self):
        self.timer_active = False
        self._timer_version += 1

    def _on_timeout(self):
        self.env.log("timeout", self.base)
        seq = self.base
        while seq != self.next_seq:
            self._transmit(seq)
            seq = (seq + 1) % self.space
        self._start_timer()

    def _transmit(self, seq):
        self.env.log("tx_frame", seq)
        self.channel.send_frame(seq, self.buffer[seq])


class Receiver:
    """GBN receiver.

    Accepts only the expected sequence number; anything else is discarded
    and the previous cumulative ACK is retransmitted.
    """

    def __init__(self, env, channel, space=SEQ_SPACE):
        self.env = env
        self.channel = channel
        self.space = space
        self.expected = 0
        self.delivered = []

    def receive_frame(self, seq, data, corrupted=False):
        if corrupted:
            self.env.log("ignore_corrupt_frame", seq)
            return
        self.env.log("rx_frame", seq)
        if seq == self.expected:
            self.delivered.append(data)
            self.env.log("deliver", data)
            ack = seq
            self.expected = (self.expected + 1) % self.space
        else:
            self.env.log("discard_frame", seq)
            ack = (self.expected - 1) % self.space
        self.env.log("tx_ack", ack)
        self.channel.send_ack(ack)
