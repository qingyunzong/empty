"""Core state machine for the replicated group.

Semantics implemented here:

1. Each configuration has a unique, monotonically increasing epoch.
2. begin_change(old, new) enters a joint configuration only when ``old``
   equals the current committed member set and no change is in progress;
   otherwise STALE_CONFIG is raised.
3. During the joint phase a write is committed only when it is acknowledged
   by a majority of the old member set AND a majority of the new member set.
4. commit_change takes effect only after a successful begin (joint phase);
   abort rolls back to the old configuration without losing acknowledged
   (committed) writes.
5. Unacknowledged (pending) writes are never persisted; a crash may lose
   them. Committed writes and the committed configuration are durable via
   fsync; a crash before the config-record fsync recovers to the pre-crash
   committed configuration.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import store

MAX_NODES = 7


class ReplError(Exception):
    """Base class for cluster errors; ``code`` is the stable error tag."""

    code = "INTERNAL"

    def __init__(self, msg: str = "", code: str | None = None):
        if code is not None:
            self.code = code
        self.msg = msg or self.code
        super().__init__(self.msg)


class StaleConfig(ReplError):
    code = "STALE_CONFIG"


class StaleEpoch(ReplError):
    code = "STALE_EPOCH"


class NotMember(ReplError):
    code = "NOT_MEMBER"


class NoPendingChange(ReplError):
    code = "NO_PENDING_CHANGE"


class UnknownProposal(ReplError):
    code = "UNKNOWN_PROPOSAL"


class InvalidConfig(ReplError):
    code = "INVALID_CONFIG"


def is_majority(count: int, total: int) -> bool:
    """True iff ``count`` acks form a majority of a ``total``-node group."""
    return count > total // 2


@dataclass
class JointConfig:
    old_members: frozenset
    new_members: frozenset
    epoch: int


class Cluster:
    """A replicated group; durable state lives in per-node disk files."""

    def __init__(self, nodes=None, data_dir=None):
        self._store = store.DiskStore(data_dir) if data_dir else None
        recovered = self._store.load() if self._store is not None else None
        if recovered is not None:
            self._load_state(recovered)
        else:
            nodes = list(nodes) if nodes else ["n1", "n2", "n3"]
            if not 1 <= len(nodes) <= MAX_NODES:
                raise InvalidConfig(f"group size must be 1..{MAX_NODES}")
            self.members = frozenset(nodes)
            self.config_epoch = 1
            self.joint: JointConfig | None = None
            self.max_epoch = 1
            self.log: list[dict] = []
            self.next_seq = 1
            self._persist()
        # Pending (unacknowledged) writes are volatile: never persisted.
        self._pending: dict[int, dict] = {}

    # -- state (de)serialisation -------------------------------------------

    def _state(self) -> dict:
        return {
            "members": sorted(self.members),
            "config_epoch": self.config_epoch,
            "joint": None
            if self.joint is None
            else {
                "old_members": sorted(self.joint.old_members),
                "new_members": sorted(self.joint.new_members),
                "epoch": self.joint.epoch,
            },
            "max_epoch": self.max_epoch,
            "log": list(self.log),
            "next_seq": self.next_seq,
        }

    def _load_state(self, state: dict) -> None:
        self.members = frozenset(state["members"])
        self.config_epoch = state["config_epoch"]
        joint = state.get("joint")
        self.joint = (
            None
            if joint is None
            else JointConfig(
                frozenset(joint["old_members"]),
                frozenset(joint["new_members"]),
                joint["epoch"],
            )
        )
        self.max_epoch = state["max_epoch"]
        self.log = sorted(state.get("log", []), key=lambda e: e["seq"])
        self.next_seq = state.get("next_seq") or (
            max((e["seq"] for e in self.log), default=0) + 1
        )

    def _persist(self, config_change: bool = False) -> None:
        if self._store is not None:
            self._store.save(self._state(), config_change=config_change)

    # -- reads ---------------------------------------------------------------

    @property
    def current_epoch(self) -> int:
        return self.joint.epoch if self.joint else self.config_epoch

    @property
    def phase(self) -> str:
        return "joint" if self.joint else "stable"

    def _voters(self) -> frozenset:
        if self.joint:
            return self.joint.old_members | self.joint.new_members
        return self.members

    def read(self) -> dict:
        return {
            "value": self.log[-1]["value"] if self.log else None,
            "epoch": self.current_epoch,
            "members": sorted(self.members),
            "phase": self.phase,
            "joint": None
            if self.joint is None
            else {
                "old_members": sorted(self.joint.old_members),
                "new_members": sorted(self.joint.new_members),
            },
            "committed": [e["value"] for e in self.log],
        }

    def is_committed(self, seq: int) -> bool:
        return any(e["seq"] == seq for e in self.log)

    # -- writes ---------------------------------------------------------------

    def propose(self, value, epoch: int | None = None) -> tuple[int, int]:
        """Stage a write; returns (seq, epoch). Stale epochs are rejected."""
        current = self.current_epoch
        ep = current if epoch is None else epoch
        if ep != current:
            raise StaleEpoch(f"proposal epoch {ep} != current epoch {current}")
        seq = self.next_seq
        self.next_seq += 1
        self._pending[seq] = {"seq": seq, "value": value, "epoch": ep, "acks": set()}
        return seq, ep

    def _quorum_reached(self, acks: set) -> bool:
        if self.joint:
            old_ok = is_majority(
                len(acks & self.joint.old_members), len(self.joint.old_members)
            )
            new_ok = is_majority(
                len(acks & self.joint.new_members), len(self.joint.new_members)
            )
            return old_ok and new_ok
        return is_majority(len(acks & self.members), len(self.members))

    def ack(self, node: str, seq: int) -> bool:
        """Record an ack; returns True iff the write is now committed."""
        if seq not in self._pending:
            if self.is_committed(seq):
                return True
            raise UnknownProposal(f"no pending proposal with seq {seq}")
        entry = self._pending[seq]
        if entry["epoch"] != self.current_epoch:
            raise StaleEpoch(
                f"proposal epoch {entry['epoch']} != current epoch {self.current_epoch}"
            )
        if node not in self._voters():
            raise NotMember(f"{node} is not a voter in the current configuration")
        entry["acks"].add(node)
        if self._quorum_reached(entry["acks"]):
            del self._pending[seq]
            self.log.append(
                {"seq": seq, "value": entry["value"], "epoch": entry["epoch"]}
            )
            self._persist()
            return True
        return False

    def write(self, value) -> int:
        """Propose and collect acks from every current voter; always commits."""
        seq, _ = self.propose(value)
        for node in sorted(self._voters()):
            self.ack(node, seq)
        return seq

    # -- reconfiguration -------------------------------------------------------

    def begin_change(self, old, new) -> int:
        """Enter joint consensus; returns the joint epoch."""
        old = frozenset(old)
        new = frozenset(new)
        if self.joint is not None:
            raise StaleConfig("a configuration change is already in progress")
        if old != self.members:
            raise StaleConfig(
                f"old config {sorted(old)} != current {sorted(self.members)}"
            )
        if not 1 <= len(new) <= MAX_NODES:
            raise InvalidConfig(f"new config size must be 1..{MAX_NODES}")
        self.joint = JointConfig(self.members, new, self.max_epoch + 1)
        self.max_epoch += 1
        self._persist(config_change=True)
        return self.joint.epoch

    def commit_change(self) -> int:
        """Leave joint consensus, installing the new config; returns its epoch."""
        if self.joint is None:
            raise NoPendingChange("no configuration change in progress")
        self.members = self.joint.new_members
        self.config_epoch = self.max_epoch + 1
        self.max_epoch += 1
        self.joint = None
        self._persist(config_change=True)
        return self.config_epoch

    def abort_change(self) -> int:
        """Roll back to the old config; committed writes are preserved."""
        if self.joint is None:
            raise NoPendingChange("no configuration change in progress")
        self.joint = None
        self._persist(config_change=True)
        return self.config_epoch
