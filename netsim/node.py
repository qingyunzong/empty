"""Simulated node: clock offset, application-id dedup, and a local log."""
from __future__ import annotations


class Node:
    def __init__(self, node_id: str, clock_offset: float = 0) -> None:
        self.id = node_id
        self.clock_offset = clock_offset
        self.seen: set[str] = set()
        self.log: list[str] = []

    def local_time(self, global_time: float) -> float:
        """Local clock reading; offset never affects global event order."""
        return global_time + self.clock_offset

    def receive(self, app_id: str) -> bool:
        """Append ``app_id`` to the log unless already seen (dedup by app id)."""
        if app_id in self.seen:
            return False
        self.seen.add(app_id)
        self.log.append(app_id)
        return True
