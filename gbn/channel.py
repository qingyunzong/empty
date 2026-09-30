"""Lossy channel with script-injected faults and a virtual clock.

Packets are stamped with an arrival tick when transmitted. Faults
(drop / corrupt / delay) are described by injection rules matched on
(kind, seq, occurrence), so e.g. "drop the first transmission of data
frame 2" is deterministic. Reordering is produced by delaying one
packet past another.
"""


class Packet:
    __slots__ = ("kind", "seq", "payload", "corrupt", "arrival")

    def __init__(self, kind, seq, payload=None, corrupt=False, arrival=0):
        self.kind = kind  # "data" | "ack"
        self.seq = seq
        self.payload = payload
        self.corrupt = corrupt
        self.arrival = arrival


class InjectionRule:
    """Match the ``occurrence``-th transmission of (kind, seq)."""

    def __init__(self, action, kind, seq, occurrence=1, by=0):
        if action not in ("drop", "corrupt", "delay"):
            raise ValueError(f"unknown action: {action!r}")
        if kind not in ("data", "ack"):
            raise ValueError(f"unknown kind: {kind!r}")
        self.action = action
        self.kind = kind
        self.seq = seq
        self.occurrence = occurrence
        self.by = by

    def matches(self, kind, seq, occurrence):
        return (
            self.kind == kind
            and self.seq == seq
            and self.occurrence == occurrence
        )


class Channel:
    """In-flight packet store driven by virtual clock ticks."""

    def __init__(self, rules=None):
        self.rules = list(rules or [])
        self.transit = []
        self._counts = {}

    def transmit(self, packet, now):
        """Put a packet into the channel; apply matching injection rules.

        Returns a list of fault events (drop / corrupt / delay).
        """
        key = (packet.kind, packet.seq)
        occurrence = self._counts.get(key, 0) + 1
        self._counts[key] = occurrence
        events = []
        delay = 1
        for rule in self.rules:
            if not rule.matches(packet.kind, packet.seq, occurrence):
                continue
            if rule.action == "drop":
                events.append(("drop", packet.kind, packet.seq))
                return events
            if rule.action == "corrupt":
                packet.corrupt = True
                events.append(("corrupt", packet.kind, packet.seq))
            elif rule.action == "delay":
                delay += rule.by
                events.append(("delay", packet.kind, packet.seq, rule.by))
        packet.arrival = now + delay
        self.transit.append(packet)
        return events

    def due(self, tick):
        """Pop all packets whose arrival tick has been reached."""
        ready = [p for p in self.transit if p.arrival <= tick]
        self.transit = [p for p in self.transit if p.arrival > tick]
        ready.sort(key=lambda p: p.arrival)
        return ready
