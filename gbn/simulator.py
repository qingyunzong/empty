"""Virtual-time simulation environment and scripted channel.

The simulation advances in integer ticks. The channel can drop, corrupt,
delay (and thereby reorder) frames/ACKs according to a script:

    "script": {
        "drop":    [{"kind": "frame", "seq": 2, "occurrence": 1}],
        "corrupt": [{"kind": "ack",   "seq": 0, "occurrence": 1}],
        "delay":   [{"kind": "frame", "seq": 3, "occurrence": 1, "extra": 3}]
    }

``occurrence`` selects which transmission of that (kind, seq) is affected
(1-based), so a frame that is dropped once is delivered on retransmission.
"""

import heapq
import itertools
from collections import defaultdict, deque

from .protocol import Sender, Receiver, WINDOW_SIZE, SEQ_SPACE

DEFAULT_MAX_TICKS = 10000


class Environment:
    """Virtual clock with a tick-ordered event queue."""

    def __init__(self):
        self.now = 0
        self._queue = []
        self._counter = itertools.count()
        self.events = []

    def schedule(self, delay, callback):
        self.schedule_at(self.now + delay, callback)

    def schedule_at(self, tick, callback):
        heapq.heappush(self._queue, (tick, next(self._counter), callback))

    def log(self, kind, *detail):
        self.events.append((self.now, kind, *detail))

    @property
    def has_pending(self):
        return bool(self._queue)

    @property
    def next_tick(self):
        return self._queue[0][0] if self._queue else None

    def step(self):
        tick, _, callback = heapq.heappop(self._queue)
        self.now = tick
        callback()


class Channel:
    """Point-to-point channel with scripted loss/corruption/delay."""

    def __init__(self, env, frame_delay=1, ack_delay=1, script=None):
        self.env = env
        self.frame_delay = frame_delay
        self.ack_delay = ack_delay
        self.sender = None
        self.receiver = None
        self._occurrences = defaultdict(int)
        script = script or {}
        self._drops = self._index(script.get("drop", []))
        self._corrupts = self._index(script.get("corrupt", []))
        self._delays = self._index(script.get("delay", []))

    @staticmethod
    def _index(rules):
        indexed = {}
        for rule in rules:
            key = (rule["kind"], rule["seq"], rule.get("occurrence", 1))
            indexed[key] = rule
        return indexed

    def _apply(self, kind, seq):
        self._occurrences[(kind, seq)] += 1
        occurrence = self._occurrences[(kind, seq)]
        key = (kind, seq, occurrence)
        action = "deliver"
        if key in self._drops:
            action = "drop"
        elif key in self._corrupts:
            action = "corrupt"
        extra = 0
        if key in self._delays:
            extra = self._delays[key].get("extra", 0)
        return action, extra

    def send_frame(self, seq, data):
        action, extra = self._apply("frame", seq)
        if action == "drop":
            self.env.log("drop_frame", seq)
            return
        corrupted = action == "corrupt"
        if corrupted:
            self.env.log("corrupt_frame", seq)
        self.env.schedule(
            self.frame_delay + extra,
            lambda: self.receiver.receive_frame(seq, data, corrupted),
        )

    def send_ack(self, ack):
        action, extra = self._apply("ack", ack)
        if action == "drop":
            self.env.log("drop_ack", ack)
            return
        corrupted = action == "corrupt"
        if corrupted:
            self.env.log("corrupt_ack", ack)
        self.env.schedule(
            self.ack_delay + extra,
            lambda: self.sender.receive_ack(ack, corrupted),
        )


def run_simulation(config):
    """Run a scripted simulation and return delivered data plus event log."""
    window = config.get("window", WINDOW_SIZE)
    space = config.get("seq_space", SEQ_SPACE)
    env = Environment()
    channel = Channel(
        env,
        frame_delay=config.get("frame_delay", 1),
        ack_delay=config.get("ack_delay", 1),
        script=config.get("script"),
    )
    sender = Sender(env, channel, window=window, space=space,
                    timeout=config.get("timeout", 10))
    receiver = Receiver(env, channel, space=space)
    channel.sender = sender
    channel.receiver = receiver

    total = len(config["messages"])
    pending = deque()

    def pump():
        # Offer queued payloads to the sender in FIFO order; the
        # non-blocking send() returns False while the window is full.
        while pending:
            if not sender.send(pending[0]):
                env.schedule(1, pump)
                return
            pending.popleft()

    def make_arrival(data):
        def arrive():
            pending.append(data)
            pump()
        return arrive

    for message in config["messages"]:
        env.schedule_at(message["tick"], make_arrival(message["data"]))

    max_ticks = config.get("max_ticks", DEFAULT_MAX_TICKS)
    while env.has_pending and len(receiver.delivered) < total:
        if env.next_tick > max_ticks:
            break
        env.step()

    return {
        "delivered": list(receiver.delivered),
        "events": [list(event) for event in env.events],
        "completed": len(receiver.delivered) == total,
        "ticks": env.now,
    }
