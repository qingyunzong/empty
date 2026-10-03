"""Replica state: delivered context, multi-value store, tombstones, membership."""
from __future__ import annotations

import json

from .context import CausalContext
from .event import DELETE, PUT, Event


class Config:
    """Explicit membership configuration, versioned monotonically."""

    def __init__(self, version, members):
        self.version = int(version)
        self.members = frozenset(tuple(m) for m in members)  # {(node_id, epoch)}

    def to_json(self):
        return {"version": self.version,
                "members": sorted([list(m) for m in self.members])}

    @classmethod
    def from_json(cls, data):
        return cls(data["version"], [tuple(m) for m in data["members"]])

    def __eq__(self, other):
        return (isinstance(other, Config) and self.version == other.version
                and self.members == other.members)

    __hash__ = None


class Node:
    def __init__(self, node_id, epoch=1, config=None):
        if "|" in node_id:
            raise ValueError("node_id must not contain '|'")
        self.node_id = node_id
        self.epoch = int(epoch)
        self.delivered = CausalContext()
        self.store = {}        # key -> {dot: (value, CausalContext)}
        self.tombstones = {}   # key -> [CausalContext] (delete contexts)
        self.pending = []      # events buffered until dependencies arrive
        self.history = []      # durable journal of every applied event
        self.config = config if config is not None else Config(0, {(node_id, epoch)})
        self.acks = {}         # (node_id, epoch) -> (config_version, CausalContext)

    @property
    def identity(self):
        return (self.node_id, self.epoch)

    # ------------------------------------------------------------------
    # local writes
    # ------------------------------------------------------------------
    def _next_dot(self):
        counter = self.delivered.max_counter(self.node_id, self.epoch) + 1
        return (self.node_id, self.epoch, counter)

    def put(self, key, value):
        return self._local_event(key, PUT, value)

    def delete(self, key):
        return self._local_event(key, DELETE, None)

    def _local_event(self, key, kind, value):
        dot = self._next_dot()
        context = self.delivered.copy()
        context.add(dot)
        event = Event(dot, key, kind, value, context)
        self._apply(event)
        return event

    # ------------------------------------------------------------------
    # delivery: dependencies must be satisfied first
    # ------------------------------------------------------------------
    def deliver(self, event):
        """Deliver a remote (or replayed) event.

        Returns "delivered", "duplicate" or "buffered" (dependencies missing).
        """
        if event.dot in self.delivered:
            return "duplicate"
        if not event.dependencies().leq(self.delivered):
            if all(p.dot != event.dot for p in self.pending):
                self.pending.append(event)
            return "buffered"
        self._apply(event)
        self._drain_pending()
        return "delivered"

    def _drain_pending(self):
        progress = True
        while progress:
            progress = False
            for event in list(self.pending):
                if event.dot in self.delivered:
                    self.pending.remove(event)
                    progress = True
                elif event.dependencies().leq(self.delivered):
                    self.pending.remove(event)
                    self._apply(event)
                    progress = True

    def _apply(self, event):
        self.delivered = self.delivered.merge(event.context)
        self.delivered.add(event.dot)
        self.history.append(event)
        versions = self.store.setdefault(event.key, {})
        if event.kind == PUT:
            if self._is_obsolete(event.key, event.context):
                return  # replayed write dominated by a delete: no resurrection
            for dot in [d for d, (_, ctx) in versions.items()
                        if ctx.leq(event.context)]:
                del versions[dot]
            versions[event.dot] = (event.value, event.context)
        else:  # DELETE
            for dot in [d for d, (_, ctx) in versions.items()
                        if ctx.leq(event.context)]:
                del versions[dot]
            self._add_tombstone(event.key, event.context)

    def _is_obsolete(self, key, context):
        return any(context.leq(t) for t in self.tombstones.get(key, ()))

    def _add_tombstone(self, key, context):
        tombs = self.tombstones.setdefault(key, [])
        if any(context.leq(t) for t in tombs):
            return
        tombs[:] = [t for t in tombs if not t.leq(context)]
        tombs.append(context)

    # ------------------------------------------------------------------
    # reads return the causally maximal live versions
    # ------------------------------------------------------------------
    def read(self, key):
        versions = self.store.get(key, {})
        result = []
        for dot, (value, ctx) in versions.items():
            dominated = any(
                other_dot != dot and ctx.leq(other_ctx)
                for other_dot, (_, other_ctx) in versions.items()
            )
            if not dominated:
                result.append({"dot": list(dot), "value": value,
                               "context": ctx.to_json()})
        result.sort(key=lambda item: (str(item["value"]), item["dot"]))
        return result

    # ------------------------------------------------------------------
    # membership, stable frontier, tombstone GC
    # ------------------------------------------------------------------
    def receive_ack(self, member, config_version, context):
        self.acks[tuple(member)] = (int(config_version), context)

    def apply_config(self, config):
        if config.version > self.config.version:
            self.config = config

    def stable_frontier(self):
        """Dots acknowledged by *every* member of the current config.

        Acks carrying a stale config version, or from non-members, never
        advance the frontier.  Missing acks yield the empty frontier.
        """
        frontier = self.delivered
        for member in sorted(self.config.members):
            if member == self.identity:
                continue
            ack = self.acks.get(member)
            if ack is None or ack[0] != self.config.version:
                return CausalContext()
            frontier = frontier.meet(ack[1])
        return frontier

    def gc_tombstones(self):
        """Reclaim tombstones covered by the stable frontier."""
        frontier = self.stable_frontier()
        reclaimed = 0
        for key in list(self.tombstones):
            kept = []
            for tomb in self.tombstones[key]:
                if tomb.leq(frontier):
                    reclaimed += 1
                else:
                    kept.append(tomb)
            if kept:
                self.tombstones[key] = kept
            else:
                del self.tombstones[key]
        return reclaimed

    # ------------------------------------------------------------------
    # snapshots (crash recovery)
    # ------------------------------------------------------------------
    def snapshot(self):
        return {
            "node_id": self.node_id,
            "epoch": self.epoch,
            "delivered": self.delivered.to_json(),
            "store": {k: [{"dot": list(d), "value": v, "context": c.to_json()}
                          for d, (v, c) in sorted(versions.items())]
                      for k, versions in sorted(self.store.items())},
            "tombstones": {k: sorted((t.to_json() for t in tombs),
                                     key=lambda j: json.dumps(j, sort_keys=True))
                           for k, tombs in sorted(self.tombstones.items())},
            "pending": [e.to_json()
                        for e in sorted(self.pending, key=lambda e: e.dot)],
            "history": [e.to_json()
                        for e in sorted(self.history, key=lambda e: e.dot)],
            "config": self.config.to_json(),
            "acks": {f"{n}|{e}": [cv, ctx.to_json()]
                     for (n, e), (cv, ctx) in sorted(self.acks.items())},
        }

    @classmethod
    def restore(cls, data):
        node = cls(data["node_id"], data["epoch"], Config.from_json(data["config"]))
        node.delivered = CausalContext.from_json(data["delivered"])
        node.store = {
            k: {tuple(e["dot"]): (e["value"], CausalContext.from_json(e["context"]))
                for e in entries}
            for k, entries in data["store"].items()
        }
        node.tombstones = {k: [CausalContext.from_json(t) for t in tombs]
                           for k, tombs in data["tombstones"].items()}
        node.pending = [Event.from_json(e) for e in data["pending"]]
        node.history = [Event.from_json(e) for e in data["history"]]
        node.acks = {tuple(k.split("|")): (cv, CausalContext.from_json(ctx))
                     for k, (cv, ctx) in data["acks"].items()}
        return node
