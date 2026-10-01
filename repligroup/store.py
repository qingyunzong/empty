"""Durable per-node state files with atomic, fsync'd replacement.

The simulated fault point is a crash immediately before the fsync of a
configuration record. Set SIM_CRASH_BEFORE_CONFIG_FSYNC=1 in the
environment to trigger os._exit(2) at exactly that point. Because the
record is written to a temp file and only atomically renamed after fsync,
a crash there leaves the previously committed configuration intact.
"""

from __future__ import annotations

import glob
import json
import os


class DiskStore:
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)

    def _path(self) -> str:
        return os.path.join(self.data_dir, "cluster-state.json")

    def load(self) -> dict | None:
        """Recover the committed state; ignore temp files from crashed writes."""
        candidates = [
            p
            for p in glob.glob(os.path.join(self.data_dir, "*.json"))
            if not p.endswith(".tmp")
        ]
        states = []
        for path in candidates:
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    states.append(json.load(fh))
            except (OSError, ValueError):
                continue
        if not states:
            return None
        # The newest committed configuration wins; committed log entries are
        # merged by seq (any persisted entry was acknowledged by a quorum).
        best = max(states, key=lambda s: s.get("max_epoch", 0))
        merged: dict[int, dict] = {}
        for state in states:
            for entry in state.get("log", []):
                merged[entry["seq"]] = entry
        best["log"] = [merged[k] for k in sorted(merged)]
        best["next_seq"] = max(
            best.get("next_seq") or 0, max(merged, default=0) + 1
        )
        return best

    def save(self, state: dict, config_change: bool = False) -> None:
        payload = json.dumps(state, sort_keys=True).encode("utf-8")
        tmp = self._path() + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        try:
            os.write(fd, payload)
            if config_change and os.environ.get("SIM_CRASH_BEFORE_CONFIG_FSYNC"):
                # Simulated crash: die before the config record is fsync'd.
                os._exit(2)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, self._path())
        dir_fd = os.open(self.data_dir, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
