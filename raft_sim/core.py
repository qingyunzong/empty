"""Core replicated-log simulator (Raft-like, <= 5 nodes).

Log entries carry (term, index, key, value); indexes start at 1.

Durability model
----------------
Persisted (survives crash): ``current_term``, ``voted_for``, ``log``,
``commit_index``.
Volatile (lost on crash):   ``role``, ``alive``.

A log append is durable immediately.  A vote (term + voted_for) is persisted
atomically.  The supported fault-injection point is "after log append, before
vote persist" (``before_vote_persist``): the node crashes and the vote never
becomes durable, so it must not count towards any election and the crashed
node must not be elected on the basis of it.

Semantics implemented
---------------------
1. ``append`` is only accepted from the live leader of the current term;
   ``ack`` (AppendEntries) returns REJECT with a conflict index when the
   follower's previous log entry does not match the leader's.
2. ``commitIndex`` is the maximum index stored by a majority of live cluster
   members whose entry at that index has term == the leader's current term.
3. Entries from older terms are never committed directly; they become
   committed only indirectly as a prefix of a current-term commit.
4. Crash between log append and vote persist: on recovery the node comes
   back with exactly its durable (term, voted_for); its term never rolls
   back below the durable value and it cannot act as leader.
5. ``repair`` performs anti-entropy from the majority-authoritative log
   (the live leader's log), truncating minority forks; it refuses to delete
   any committed entry.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

MAX_NODES = 5
FAULT_BEFORE_VOTE_PERSIST = "before_vote_persist"


class ProtocolError(Exception):
    """Invalid command or protocol violation. The CLI maps this to exit 11."""


@dataclass
class Entry:
    term: int
    index: int
    key: str
    value: Any = None

    def to_dict(self) -> dict:
        return {"term": self.term, "index": self.index,
                "key": self.key, "value": self.value}


@dataclass
class Node:
    name: str
    # durable state
    current_term: int = 0
    voted_for: Optional[str] = None
    log: list = field(default_factory=list)  # list[Entry]
    commit_index: int = 0
    # volatile state
    alive: bool = True
    role: str = "follower"  # follower | leader

    @property
    def last_index(self) -> int:
        return len(self.log)

    @property
    def last_term(self) -> int:
        return self.log[-1].term if self.log else 0


def common_prefix_len(a: list, b: list) -> int:
    """Length of the longest prefix on which logs a and b agree (by term)."""
    n = 0
    for ea, eb in zip(a, b):
        if ea.term != eb.term:
            break
        n += 1
    return n


class Cluster:
    def __init__(self, size: int):
        if isinstance(size, bool) or not isinstance(size, int) \
                or not 1 <= size <= MAX_NODES:
            raise ProtocolError(
                f"init: nodes must be an integer in [1, {MAX_NODES}]")
        self.size = size
        self.nodes = {f"n{i + 1}": Node(f"n{i + 1}") for i in range(size)}

    @property
    def majority(self) -> int:
        return self.size // 2 + 1

    # ------------------------------------------------------------------ util
    def _node(self, name: str) -> Node:
        if not isinstance(name, str) or name not in self.nodes:
            raise ProtocolError(f"unknown node: {name!r}")
        return self.nodes[name]

    def leader(self) -> Optional[Node]:
        for node in self.nodes.values():
            if node.alive and node.role == "leader":
                return node
        return None

    def _require_leader(self, name: Optional[str] = None) -> Node:
        if name is not None:
            node = self._node(name)
            if not node.alive or node.role != "leader":
                raise ProtocolError(f"{name} is not a live leader")
            return node
        leader = self.leader()
        if leader is None:
            raise ProtocolError("no live leader")
        return leader

    # ------------------------------------------------------------------ elect
    def elect(self, candidate: str, term: int, fault: Optional[dict] = None) -> dict:
        c = self._node(candidate)
        if not c.alive:
            raise ProtocolError(f"elect: candidate {candidate} is crashed")
        if isinstance(term, bool) or not isinstance(term, int) or term < 1:
            raise ProtocolError("elect: term must be a positive integer")
        if fault is not None:
            if not isinstance(fault, dict) \
                    or fault.get("point") != FAULT_BEFORE_VOTE_PERSIST \
                    or not isinstance(fault.get("node"), str):
                raise ProtocolError(
                    "elect: fault must be "
                    '{"node": <name>, "point": "before_vote_persist"}')
            self._node(fault["node"])
        if c.role == "leader" and c.current_term == term:
            return {"elected": True, "already": True,
                    "term": term, "leader": candidate}
        if term < c.current_term:
            raise ProtocolError(
                f"elect: term {term} < current term {c.current_term} "
                f"of {candidate}")
        if term == c.current_term and c.voted_for != candidate:
            raise ProtocolError(
                f"elect: {candidate} already voted for {c.voted_for} "
                f"in term {term}")

        # The candidate must durably persist (term, voted_for=self) before
        # its election can count.
        if fault and fault["node"] == candidate:
            c.alive = False
            c.role = "follower"
            return {"elected": False, "term": term, "votes": [],
                    "crashed": candidate,
                    "reason": "candidate crashed before persisting its vote"}
        c.current_term = term
        c.voted_for = candidate
        votes = [candidate]

        for node in self.nodes.values():
            if node.name == candidate or not node.alive:
                continue
            if not self._grants(node, c, term):
                continue
            if fault and fault["node"] == node.name:
                # Crash after log append, before the vote is persisted:
                # the vote is lost and must not be counted.
                node.alive = False
                node.role = "follower"
                continue
            node.current_term = term
            node.voted_for = candidate
            node.role = "follower"
            votes.append(node.name)

        elected = len(votes) >= self.majority
        if elected:
            for node in self.nodes.values():
                if node.role == "leader" and node.current_term <= term:
                    node.role = "follower"
            c.role = "leader"
        return {"elected": elected, "term": term, "votes": votes}

    @staticmethod
    def _grants(voter: Node, candidate: Node, term: int) -> bool:
        if term < voter.current_term:
            return False
        if term == voter.current_term \
                and voter.voted_for not in (None, candidate.name):
            return False
        return (candidate.last_term, candidate.last_index) >= \
               (voter.last_term, voter.last_index)

    # ----------------------------------------------------------------- append
    def append(self, key: str, value: Any = None,
               leader: Optional[str] = None) -> dict:
        if not isinstance(key, str):
            raise ProtocolError("append: key must be a string")
        node = self._require_leader(leader)
        entry = Entry(term=node.current_term, index=node.last_index + 1,
                      key=key, value=value)
        node.log.append(entry)  # durable immediately
        return {"leader": node.name, "index": entry.index, "term": entry.term}

    # -------------------------------------------------------------------- ack
    def ack(self, follower: str, leader: Optional[str] = None) -> dict:
        node = self._require_leader(leader)
        f = self._node(follower)
        if not f.alive:
            raise ProtocolError(f"ack: follower {follower} is crashed")
        if f.name == node.name:
            return {"ack": True, "follower": f.name, "leader": node.name,
                    "matchIndex": node.last_index}
        if f.current_term > node.current_term:
            node.role = "follower"
            return {"ack": False, "reason": "STALE_TERM", "follower": f.name,
                    "leader": node.name, "followerTerm": f.current_term}
        if f.current_term < node.current_term:
            f.current_term = node.current_term
            f.voted_for = None
            f.role = "follower"
        common = common_prefix_len(node.log, f.log)
        if common < f.last_index:
            # prevLog mismatch: the follower holds a conflicting fork.
            return {"ack": False, "reason": "REJECT", "follower": f.name,
                    "leader": node.name, "conflictIndex": common + 1,
                    "conflictTerm": f.log[common].term}
        # Follower log is a prefix of the leader log: append the missing
        # suffix (durable) and learn the leader's commit index.
        for e in node.log[f.last_index:]:
            f.log.append(Entry(e.term, e.index, e.key, e.value))
        f.commit_index = max(f.commit_index,
                             min(node.commit_index, f.last_index))
        return {"ack": True, "follower": f.name, "leader": node.name,
                "matchIndex": f.last_index}

    # ----------------------------------------------------------------- commit
    def commit(self, leader: Optional[str] = None) -> dict:
        node = self._require_leader(leader)
        node.commit_index = max(node.commit_index,
                                self._compute_commit_index(node))
        return {"leader": node.name, "commitIndex": node.commit_index}

    def _compute_commit_index(self, leader: Node) -> int:
        """Max index stored by a live majority with term == current term.

        Only live replicas can acknowledge, so only live nodes are counted;
        the quorum is a majority of the whole cluster.  Entries from older
        terms never qualify directly (rule 3).
        """
        term = leader.current_term
        for idx in range(leader.last_index, 0, -1):
            stored = sum(
                1 for n in self.nodes.values()
                if n.alive and n.last_index >= idx
                and n.log[idx - 1].term == term)
            if stored >= self.majority:
                return idx
        return 0

    #                                                        crash / recover
    def crash(self, name: str) -> dict:
        node = self._node(name)
        node.alive = False
        node.role = "follower"
        return {"node": name, "alive": False}

    def recover(self, name: str) -> dict:
        node = self._node(name)
        node.alive = True
        node.role = "follower"
        # The node comes back with exactly its durable state: term never
        # rolls back below the durable value, and any vote that was not
        # persisted is gone, so it cannot act as leader.
        return {"node": name, "alive": True, "term": node.current_term,
                "votedFor": node.voted_for, "logLength": node.last_index,
                "commitIndex": node.commit_index}

    # ----------------------------------------------------------------- repair
    def repair(self, leader: Optional[str] = None) -> dict:
        """Anti-entropy: truncate minority forks from the authoritative log.

        The live leader's log is majority-authoritative (it was elected by a
        majority and contains every committed entry).  Every live follower's
        log is made identical to it.  Deleting a committed entry is refused.
        """
        node = self._require_leader(leader)
        auth = node.log
        repaired, skipped = [], []
        for f in self.nodes.values():
            if f.name == node.name:
                continue
            if not f.alive:
                skipped.append(f.name)
                continue
            # Safety guard: never delete a committed entry.
            for i in range(f.commit_index):
                if i >= len(auth) or auth[i].term != f.log[i].term:
                    raise ProtocolError(
                        f"repair refused: committed entry at index {i + 1} "
                        f"on {f.name} is not in the authoritative log")
            common = common_prefix_len(auth, f.log)
            truncated = f.last_index - common
            if truncated:
                del f.log[common:]
            for e in auth[f.last_index:]:
                f.log.append(Entry(e.term, e.index, e.key, e.value))
            f.commit_index = max(f.commit_index,
                                 min(node.commit_index, f.last_index))
            repaired.append({"node": f.name, "truncated": truncated,
                             "matchIndex": f.last_index})
        return {"leader": node.name, "repaired": repaired, "skipped": skipped}

    # ------------------------------------------------------------------ state
    def state(self) -> dict:
        leader = self.leader()
        return {
            "size": self.size,
            "leader": leader.name if leader else None,
            "nodes": {name: {
                "term": n.current_term,
                "votedFor": n.voted_for,
                "role": n.role,
                "alive": n.alive,
                "commitIndex": n.commit_index,
                "log": [e.to_dict() for e in n.log],
            } for name, n in self.nodes.items()},
        }
