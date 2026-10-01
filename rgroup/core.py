"""Core replicated-group state machine with epoch'd configs and joint consensus.

Semantics implemented:
  1. Every committed config has a unique, monotonically increasing epoch.
  2. begin_change(old, new) enters joint only if `old` is the current member
     set and no change is in flight; otherwise STALE_CONFIG.
  3. During joint, a write commits only when acked by a majority of the old
     config AND a majority of the new config.
  4. commit_change takes effect only from a successful joint; abort rolls
     back to the old config without losing any confirmed write.
  5. Unconfirmed writes are never persisted. Committed config + committed
     writes are fsynced to disk; a crash before the config record fsync
     recovers to the pre-crash committed config.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

MAX_NODES = 7

STATE_FILE = "state.json"


class Error(Exception):
    """Base error; `code` is the machine-readable error name."""

    code = "INTERNAL"

    def __init__(self, message: str = ""):
        super().__init__(message or self.code)


class StaleConfig(Error):
    code = "STALE_CONFIG"


class NotInJoint(Error):
    code = "NOT_IN_JOINT"


class UnknownWrite(Error):
    code = "UNKNOWN_WRITE"


class UnknownNode(Error):
    code = "UNKNOWN_NODE"


class BadConfig(Error):
    code = "BAD_CONFIG"


class NoGroup(Error):
    code = "NO_GROUP"


class CrashError(Error):
    """Simulated crash at a fault-injection point."""

    code = "CRASH"


def is_majority(acks: Iterable[Any], members: Iterable[Any]) -> bool:
    """True iff `acks` covers a strict majority of `members`."""
    members = set(members)
    if not members:
        return False
    return len(set(acks) & members) * 2 > len(members)


@dataclass(frozen=True)
class Config:
    members: frozenset
    epoch: int

    def to_dict(self) -> dict:
        return {"members": sorted(self.members), "epoch": self.epoch}


@dataclass
class Write:
    id: int
    value: Any
    epoch: int
    acks: set = field(default_factory=set)
    committed: bool = False


def _validate_members(members: Iterable[Any]) -> frozenset:
    members = frozenset(members)
    if not members:
        raise BadConfig("member set must be non-empty")
    if len(members) > MAX_NODES:
        raise BadConfig(f"member set exceeds {MAX_NODES} nodes")
    return members


class Group:
    """A single replication group (<= MAX_NODES members)."""

    def __init__(self, members: Iterable[Any], epoch: int = 1, path: Optional[str] = None):
        members = _validate_members(members)
        self.config = Config(members, epoch)
        self.joint: Optional[tuple[frozenset, frozenset]] = None  # (old, new)
        self.writes: dict[int, Write] = {}
        self.committed: list[tuple[int, Any]] = []  # (write id, value) in commit order
        self.next_id = 1
        # Last config epoch known to each node; nodes left behind by a config
        # change keep their stale epoch and can no longer serve writes.
        self.known: dict[Any, int] = {m: epoch for m in members}
        self.path = path
        self.failpoint: Optional[str] = None

    # ------------------------------------------------------------------
    # persistence
    # ------------------------------------------------------------------
    def _persist(self) -> None:
        """Atomically persist committed config + committed writes (fsync)."""
        if self.path is None:
            return
        if self.failpoint == "before_config_fsync":
            # Fault point: crash before the config record is fsynced. The
            # on-disk committed state is left untouched.
            raise CrashError("simulated crash before config record fsync")
        os.makedirs(self.path, exist_ok=True)
        payload = json.dumps(
            {
                "config": self.config.to_dict(),
                "committed": [[wid, value] for wid, value in self.committed],
            }
        )
        tmp = os.path.join(self.path, STATE_FILE + ".tmp")
        final = os.path.join(self.path, STATE_FILE)
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, final)
        dirfd = os.open(self.path, os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)

    @classmethod
    def load(cls, path: str) -> "Group":
        """Recover a group from disk: last committed config + committed writes.

        Joint state and unconfirmed writes live only in memory, so recovery
        always returns to the pre-crash committed configuration.
        """
        final = os.path.join(path, STATE_FILE)
        if not os.path.exists(final):
            raise NoGroup(f"no persisted group at {path}")
        with open(final, encoding="utf-8") as fh:
            data = json.load(fh)
        group = cls.__new__(cls)
        cfg = data["config"]
        group.config = Config(frozenset(cfg["members"]), cfg["epoch"])
        group.joint = None
        group.writes = {}
        group.committed = [(wid, value) for wid, value in data["committed"]]
        group.next_id = max((wid for wid, _ in group.committed), default=0) + 1
        group.known = {m: cfg["epoch"] for m in cfg["members"]}
        group.path = path
        group.failpoint = None
        return group

    # ------------------------------------------------------------------
    # quorum / writes
    # ------------------------------------------------------------------
    def _check_node_current(self, node: Any) -> None:
        if node not in self.known:
            raise UnknownNode(f"unknown node {node!r}")
        if self.known[node] != self.config.epoch:
            raise StaleConfig(
                f"node {node!r} at epoch {self.known[node]}, "
                f"current epoch is {self.config.epoch}"
            )

    def _quorum_met(self, write: Write) -> bool:
        if self.joint is not None:
            old, new = self.joint
            return is_majority(write.acks, old) and is_majority(write.acks, new)
        return is_majority(write.acks, self.config.members)

    def _evaluate(self, write: Write) -> bool:
        if not write.committed and self._quorum_met(write):
            write.committed = True
            self.committed.append((write.id, write.value))
            self._persist()  # confirmed writes are durable before being reported
        return write.committed

    def propose(self, value: Any, node: Any = None) -> Write:
        """Create a write at the current epoch; optionally acked by `node`."""
        if node is not None:
            self._check_node_current(node)
        write = Write(id=self.next_id, value=value, epoch=self.config.epoch)
        self.next_id += 1
        if node is not None:
            write.acks.add(node)
        self.writes[write.id] = write
        self._evaluate(write)
        return write

    def write(self, value: Any, node: Any) -> Write:
        """Client write through `node`: propose + the node's own ack."""
        return self.propose(value, node=node)

    def ack(self, write_id: int, node: Any) -> bool:
        """Record `node`'s ack; returns True iff the write is committed."""
        write = self.writes.get(write_id)
        if write is None:
            raise UnknownWrite(f"unknown write id {write_id}")
        if write.epoch != self.config.epoch:
            raise StaleConfig(
                f"write {write_id} proposed at epoch {write.epoch}, "
                f"current epoch is {self.config.epoch}"
            )
        self._check_node_current(node)
        write.acks.add(node)
        return self._evaluate(write)

    def read(self) -> Any:
        """Return the most recently committed value (None if none)."""
        return self.committed[-1][1] if self.committed else None

    # ------------------------------------------------------------------
    # membership changes (two-phase joint consensus)
    # ------------------------------------------------------------------
    def begin_change(self, old: Iterable[Any], new: Iterable[Any]) -> None:
        old = frozenset(old)
        new = _validate_members(new)
        if self.joint is not None:
            raise StaleConfig("a membership change is already in flight")
        if old != self.config.members:
            raise StaleConfig(
                f"old {sorted(old)!r} does not match current "
                f"config {sorted(self.config.members)!r}"
            )
        self.joint = (self.config.members, new)
        for member in new:
            self.known.setdefault(member, self.config.epoch)

    def commit_change(self) -> Config:
        if self.joint is None:
            raise NotInJoint("no membership change in flight")
        _, new = self.joint
        self.config = Config(new, self.config.epoch + 1)
        self.joint = None
        for member in new:
            self.known[member] = self.config.epoch
        # Nodes removed from the group keep their old (now stale) epoch.
        self._persist()
        return self.config

    def abort(self) -> Config:
        if self.joint is None:
            raise NotInJoint("no membership change in flight")
        self.joint = None
        # Committed writes are untouched; the old config stays in effect.
        return self.config

    # ------------------------------------------------------------------
    # introspection
    # ------------------------------------------------------------------
    def status(self) -> dict:
        return {
            "config": self.config.to_dict(),
            "joint": (
                {"old": sorted(self.joint[0]), "new": sorted(self.joint[1])}
                if self.joint
                else None
            ),
            "committed": [[wid, value] for wid, value in self.committed],
            "pending": [
                {"id": w.id, "epoch": w.epoch, "acks": sorted(w.acks)}
                for w in self.writes.values()
                if not w.committed
            ],
            "known_epochs": {str(k): v for k, v in sorted(self.known.items(), key=lambda kv: str(kv[0]))},
        }
