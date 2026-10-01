"""Replica state machine: multi-value register store with tombstones,
epoch-scoped membership, stable-frontier GC and snapshot/restore.

Delivery rules:
  * A put is deliverable only when its causal dependencies are satisfied
    *and* its dot extends the sender stream contiguously (no gaps).
  * A delete is deliverable when its context is fully covered locally.
  * Old (replayed or retired-epoch) messages never resurrect deleted
    values: a put whose context is covered by a tombstone is dropped.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .dvv import CausalContext, Dot

Identity = Tuple[str, int]  # (node, epoch)


@dataclass(frozen=True)
class Entry:
    key: str
    value: str
    dot: Dot
    context: CausalContext  # includes `dot`

    def to_json(self) -> dict:
        return {
            "key": self.key,
            "value": self.value,
            "dot": list(self.dot),
            "context": self.context.to_json(),
        }

    @classmethod
    def from_json(cls, data: dict) -> "Entry":
        return cls(
            data["key"],
            data["value"],
            tuple(data["dot"]),
            CausalContext.from_json(data["context"]),
        )


@dataclass(frozen=True)
class Tombstone:
    key: str
    context: CausalContext

    def to_json(self) -> dict:
        return {"key": self.key, "context": self.context.to_json()}

    @classmethod
    def from_json(cls, data: dict) -> "Tombstone":
        return cls(data["key"], CausalContext.from_json(data["context"]))


class Replica:
    """One replica of the collaborative store."""

    def __init__(self, node_id: str, epoch: int = 1):
        self.node_id = node_id
        self.epoch = epoch
        self.counter = 0
        self.kv = CausalContext.empty()
        self.entries: Dict[str, List[Entry]] = {}
        self.tombstones: Dict[str, List[Tombstone]] = {}
        self.config_version = 0
        self.members: List[Identity] = []
        self.acks: Dict[Identity, Tuple[int, CausalContext]] = {}
        self.buffer: List[Tuple[str, object]] = []  # undeliverable messages

    @property
    def identity(self) -> Identity:
        return (self.node_id, self.epoch)

    # -- local operations ---------------------------------------------------
    def write(self, key: str, value: str) -> Entry:
        self.counter += 1
        dot = (self.node_id, self.epoch, self.counter)
        entry = Entry(key, value, dot, self.kv.add(dot))
        self._apply_entry(entry)
        return entry

    def delete(self, key: str) -> Tombstone:
        tomb = Tombstone(key, self.kv)
        self._apply_tombstone(tomb)
        return tomb

    def read(self, key: str) -> List[str]:
        """Causally maximal values for ``key`` (siblings on concurrency)."""
        entries = self.entries.get(key, [])
        maximal = [
            e
            for e in entries
            if not any(other.context.dominates(e.context) for other in entries)
        ]
        return sorted(e.value for e in maximal)

    # -- delivery preconditions ----------------------------------------------
    def can_deliver_put(self, entry: Entry) -> bool:
        node, epoch, cnt = entry.dot
        if self.kv.clock.get((node, epoch), 0) != cnt - 1:
            return False  # gap: a dotted context cannot fake a prefix
        deps = entry.context.minus(entry.dot)
        return deps.leq(self.kv)

    def can_deliver_delete(self, tomb: Tombstone) -> bool:
        return tomb.context.leq(self.kv)

    # -- remote application ---------------------------------------------------
    def deliver_put(self, entry: Entry) -> bool:
        if entry.context.leq(self.kv):
            return True  # duplicate delivery: idempotent no-op
        if not self.can_deliver_put(entry):
            self.buffer.append(("put", entry))
            return False
        self._apply_entry(entry)
        self._flush_buffer()
        return True

    def deliver_delete(self, tomb: Tombstone) -> bool:
        if any(
            tomb.context.leq(t.context)
            for t in self.tombstones.get(tomb.key, [])
        ):
            return True  # duplicate delivery: idempotent no-op
        if not self.can_deliver_delete(tomb):
            self.buffer.append(("del", tomb))
            return False
        self._apply_tombstone(tomb)
        self._flush_buffer()
        return True

    def _flush_buffer(self) -> None:
        progressed = True
        while progressed:
            progressed = False
            for item in list(self.buffer):
                kind, payload = item
                ok = (
                    self.can_deliver_put(payload)
                    if kind == "put"
                    else self.can_deliver_delete(payload)
                )
                if ok:
                    self.buffer.remove(item)
                    if kind == "put":
                        self._apply_entry(payload)
                    else:
                        self._apply_tombstone(payload)
                    progressed = True

    def _apply_entry(self, entry: Entry) -> None:
        if entry.context.leq(self.kv):
            return  # duplicate delivery: idempotent
        tombs = self.tombstones.get(entry.key, [])
        if any(entry.context.leq(t.context) for t in tombs):
            self.kv = self.kv.merge(entry.context)
            return  # deleted already: old writes never resurrect values
        siblings = self.entries.setdefault(entry.key, [])
        survivors = [
            e for e in siblings if not entry.context.dominates(e.context)
        ]
        if not any(e.context.dominates(entry.context) for e in survivors):
            survivors.append(entry)
        self.entries[entry.key] = survivors
        self.kv = self.kv.merge(entry.context)

    def _apply_tombstone(self, tomb: Tombstone) -> None:
        tombs = self.tombstones.setdefault(tomb.key, [])
        if any(tomb.context.leq(t.context) for t in tombs):
            pass  # already covered
        else:
            tombs[:] = [
                t for t in tombs if not tomb.context.dominates(t.context)
            ]
            tombs.append(tomb)
        siblings = self.entries.get(tomb.key, [])
        self.entries[tomb.key] = [
            e for e in siblings if not e.context.leq(tomb.context)
        ]
        self.kv = self.kv.merge(tomb.context)

    # -- membership / configuration -------------------------------------------
    def set_config(self, version: int, members: List[Identity]) -> bool:
        if version <= self.config_version:
            return False
        self.config_version = version
        self.members = [tuple(m) for m in members]
        return True

    def receive_ack(
        self, identity: Identity, config_version: int, vector: CausalContext
    ) -> None:
        identity = tuple(identity)
        current = self.acks.get(identity)
        if current is not None and current[0] > config_version:
            return
        if current is not None and current[0] == config_version:
            vector = current[1].merge(vector)
        self.acks[identity] = (config_version, vector)

    def stable_frontier(self) -> Optional[CausalContext]:
        """Componentwise minimum over current members' acknowledged vectors.

        Only acks matching the *current* config version count; acks from a
        lagging configuration never advance the frontier.  Returns ``None``
        when any current member has no matching ack yet.
        """
        vectors = [self.kv]
        for member in self.members:
            if member == self.identity:
                continue
            ack = self.acks.get(member)
            if ack is None or ack[0] != self.config_version:
                return None
            vectors.append(ack[1])
        keys = set().union(*(v.clock.keys() for v in vectors))
        clock = {k: min(v.clock.get(k, 0) for v in vectors) for k in keys}
        clock = {k: c for k, c in clock.items() if c > 0}
        return CausalContext(clock)

    def gc_tombstones(self) -> int:
        """Collect tombstones covered by the stable frontier."""
        frontier = self.stable_frontier()
        if frontier is None:
            return 0
        collected = 0
        for key in list(self.tombstones):
            kept = []
            for tomb in self.tombstones[key]:
                if tomb.context.leq(frontier) and not tomb.context.is_empty():
                    collected += 1
                else:
                    kept.append(tomb)
            if kept:
                self.tombstones[key] = kept
            else:
                del self.tombstones[key]
        return collected

    # -- state merge (CRDT join) ------------------------------------------------
    def merge_state(self, other: "Replica") -> None:
        """Join another replica's store state.  Associative, commutative,
        idempotent.  Purely monotonic: safe to retry after a crash."""
        for key, entries in other.entries.items():
            for entry in entries:
                if not entry.context.leq(self.kv):
                    self._apply_entry(entry)
        for key, tombs in other.tombstones.items():
            for tomb in tombs:
                self._apply_tombstone(tomb)
        self.kv = self.kv.merge(other.kv)

    # -- snapshot / restore ------------------------------------------------------
    def snapshot(self) -> dict:
        return {
            "node_id": self.node_id,
            "epoch": self.epoch,
            "counter": self.counter,
            "kv": self.kv.to_json(),
            "entries": {
                k: [e.to_json() for e in v] for k, v in self.entries.items()
            },
            "tombstones": {
                k: [t.to_json() for t in v] for k, v in self.tombstones.items()
            },
            "config_version": self.config_version,
            "members": [list(m) for m in self.members],
            "acks": {
                f"{n}|{e}": [cv, ctx.to_json()]
                for (n, e), (cv, ctx) in self.acks.items()
            },
        }

    @classmethod
    def restore(cls, snap: dict) -> "Replica":
        replica = cls(snap["node_id"], snap["epoch"])
        replica.counter = snap["counter"]
        replica.kv = CausalContext.from_json(snap["kv"])
        replica.entries = {
            k: [Entry.from_json(e) for e in v]
            for k, v in snap["entries"].items()
        }
        replica.tombstones = {
            k: [Tombstone.from_json(t) for t in v]
            for k, v in snap["tombstones"].items()
        }
        replica.config_version = snap["config_version"]
        replica.members = [tuple(m) for m in snap["members"]]
        replica.acks = {
            tuple(k.split("|")): (cv, CausalContext.from_json(ctx))
            for k, (cv, ctx) in snap["acks"].items()
        }
        replica.acks = {
            (str(n), int(e)): v for (n, e), v in replica.acks.items()
        }
        return replica
