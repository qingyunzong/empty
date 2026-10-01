"""Independent pure-Python reference model for the MVCC store.

Deliberately implemented with plain dict snapshots rather than version
chains, so the randomized differential test cross-checks two different
implementations of the same semantics.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

_ACTIVE = "active"
_COMMITTED = "committed"
_ABORTED = "aborted"


class RefError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class RefModel:
    def __init__(self) -> None:
        self.committed: Dict[str, Any] = {}  # key -> committed value
        self.txns: Dict[str, Dict[str, Any]] = {}
        self.clock = 0

    def begin(self, txn_id: str, mode: str) -> None:
        if mode not in ("snapshot", "read_committed"):
            raise RefError("INVALID_MODE")
        existing = self.txns.get(txn_id)
        if existing is not None and existing["state"] == _ACTIVE:
            raise RefError("TXN_STATE")
        self.txns[txn_id] = {
            "mode": mode,
            "snap": dict(self.committed),
            "writes": {},  # key -> value, or None for delete
            "state": _ACTIVE,
        }
        return txn_id

    def _active(self, txn_id: str) -> Dict[str, Any]:
        txn = self.txns.get(txn_id)
        if txn is None or txn["state"] != _ACTIVE:
            raise RefError("TXN_STATE")
        return txn

    def get(self, txn_id: str, key: str) -> Any:
        txn = self._active(txn_id)
        if key in txn["writes"]:
            return txn["writes"][key]  # None means deleted by this txn
        if txn["mode"] == "snapshot":
            return txn["snap"].get(key)
        return self.committed.get(key)

    def put(self, txn_id: str, key: str, value: Any) -> None:
        self._active(txn_id)["writes"][key] = value

    def delete(self, txn_id: str, key: str) -> None:
        self._active(txn_id)["writes"][key] = None

    def commit(self, txn_id: str) -> int:
        txn = self._active(txn_id)
        self.clock += 1
        for key, value in txn["writes"].items():
            if value is None:
                self.committed.pop(key, None)
            else:
                self.committed[key] = value
        txn["state"] = _COMMITTED
        return self.clock

    def abort(self, txn_id: str) -> None:
        txn = self._active(txn_id)
        txn["writes"].clear()
        txn["state"] = _ABORTED
