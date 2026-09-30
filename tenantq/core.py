"""Hierarchical tenant quota engine.

Semantics:
- reserve: walk the tenant chain leaf->root, tentatively add ``pending`` at
  every level; if any level would exceed its quota, roll every level back to
  its pre-operation value and record a FAILED reservation.
- confirm: convert ``pending`` into ``used`` along the chain.
- release: subtract from ``used`` only.
- quota 0 forbids any reservation; a tenant node missing from the quota
  config raises E_CONFIG instead of being treated as unlimited.
"""

from __future__ import annotations

E_QUOTA = "E_QUOTA"
E_STATE = "E_STATE"
E_CONFIG = "E_CONFIG"
E_ARGS = "E_ARGS"

PENDING = "PENDING"
CONFIRMED = "CONFIRMED"
RELEASED = "RELEASED"
FAILED = "FAILED"


class PolicyError(Exception):
    """Quota policy violation carrying a stable machine-readable code."""

    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details

    def to_dict(self):
        payload = {"code": self.code, "message": self.message}
        payload.update(self.details)
        return payload


def tenant_chain(path):
    """Return the chain of tenant paths from leaf to root."""
    if not isinstance(path, str) or not path.strip("/"):
        raise PolicyError(E_ARGS, "tenant path must be a non-empty string")
    parts = [part for part in path.split("/") if part]
    return ["/".join(parts[:i]) for i in range(len(parts), 0, -1)]


def _valid_amount(amount):
    if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
        raise PolicyError(E_ARGS, f"amount must be a positive integer, got {amount!r}")
    return amount


class Engine:
    def __init__(self, quotas):
        self.quotas = {}
        for path, quota in quotas.items():
            quota = int(quota)
            if quota < 0:
                raise PolicyError(E_CONFIG, f"negative quota for tenant node {path!r}")
            self.quotas[path] = quota
        self.pending = {path: 0 for path in self.quotas}
        self.used = {path: 0 for path in self.quotas}
        self.reservations = {}
        self.key_index = {}
        self.counter = 0

    # -- operations ------------------------------------------------------

    def reserve(self, tenant, amount, key):
        amount = _valid_amount(amount)
        chain = tenant_chain(tenant)
        existing = self.key_index.get(key)
        if existing is not None:
            record = self.reservations[existing]
            if record["state"] != FAILED:
                # Idempotent replay: return the original result, no re-charge.
                return dict(record["result"])
        for node in chain:
            if node not in self.quotas:
                raise PolicyError(
                    E_CONFIG, f"missing quota config for tenant node {node!r}", tenant=node
                )
        self.counter += 1
        rid = f"rsv-{self.counter}"
        applied = []
        try:
            for node in chain:
                self.pending[node] += amount
                applied.append(node)
                if self.pending[node] + self.used[node] > self.quotas[node]:
                    raise PolicyError(
                        E_QUOTA, f"insufficient quota at tenant node {node!r}", tenant=node
                    )
        except PolicyError as exc:
            # Roll every tentatively incremented level back to its prior value.
            for node in applied:
                self.pending[node] -= amount
            self.reservations[rid] = {
                "id": rid, "key": key, "tenant": tenant, "amount": amount,
                "state": FAILED, "released": 0, "result": None,
            }
            self.key_index[key] = rid
            exc.details.setdefault("reservation_id", rid)
            raise
        result = {
            "status": "ok", "reservation_id": rid, "idempotency_key": key,
            "tenant": tenant, "amount": amount, "state": PENDING,
        }
        self.reservations[rid] = {
            "id": rid, "key": key, "tenant": tenant, "amount": amount,
            "state": PENDING, "released": 0, "result": result,
        }
        self.key_index[key] = rid
        return dict(result)

    def confirm(self, key=None, reservation_id=None):
        record = self._lookup(key, reservation_id)
        if record["state"] in (FAILED, RELEASED):
            raise PolicyError(
                E_STATE,
                f"cannot confirm reservation in state {record['state']}",
                reservation_id=record["id"], state=record["state"],
            )
        if record["state"] == PENDING:
            for node in tenant_chain(record["tenant"]):
                self.pending[node] -= record["amount"]
                self.used[node] += record["amount"]
            record["state"] = CONFIRMED
        return {"status": "ok", "reservation_id": record["id"], "state": CONFIRMED}

    def release(self, key=None, reservation_id=None, amount=None):
        record = self._lookup(key, reservation_id)
        if record["state"] != CONFIRMED:
            raise PolicyError(
                E_STATE,
                f"cannot release reservation in state {record['state']}",
                reservation_id=record["id"], state=record["state"],
            )
        remaining = record["amount"] - record["released"]
        if amount is None:
            amount = remaining
        amount = _valid_amount(amount)
        if amount > remaining:
            raise PolicyError(
                E_ARGS,
                f"release amount {amount} exceeds remaining {remaining}",
                reservation_id=record["id"],
            )
        chain = tenant_chain(record["tenant"])
        for node in chain:
            if self.used[node] < amount:
                raise PolicyError(
                    E_STATE, "ledger inconsistency: used below release amount", tenant=node
                )
        for node in chain:
            self.used[node] -= amount
        record["released"] += amount
        if record["released"] == record["amount"]:
            record["state"] = RELEASED
        return {
            "status": "ok", "reservation_id": record["id"],
            "released": record["released"], "state": record["state"],
        }

    # -- helpers ---------------------------------------------------------

    def _lookup(self, key, reservation_id):
        if key is None and reservation_id is None:
            raise PolicyError(E_ARGS, "provide key or reservation_id")
        rid = reservation_id if reservation_id is not None else self.key_index.get(key)
        record = self.reservations.get(rid) if rid is not None else None
        if record is None:
            raise PolicyError(E_STATE, "reservation not found", key=key,
                              reservation_id=reservation_id)
        return record

    def snapshot(self):
        return {
            "pending": dict(self.pending),
            "used": dict(self.used),
            "reservations": {
                rid: {k: v for k, v in rec.items() if k != "result"}
                for rid, rec in self.reservations.items()
            },
        }

    # -- persistence -----------------------------------------------------

    def to_dict(self):
        return {
            "pending": self.pending,
            "used": self.used,
            "reservations": self.reservations,
            "key_index": self.key_index,
            "counter": self.counter,
        }

    @classmethod
    def from_dict(cls, quotas, data):
        engine = cls(quotas)
        engine.pending = {path: int(v) for path, v in data.get("pending", {}).items()}
        engine.used = {path: int(v) for path, v in data.get("used", {}).items()}
        engine.reservations = dict(data.get("reservations", {}))
        engine.key_index = dict(data.get("key_index", {}))
        engine.counter = int(data.get("counter", 0))
        return engine
