"""Core engine for hierarchical tenant quota reservations.

Semantics:
  * reserve  -- walk the tenant chain leaf->root; every level must have a
                configured quota for the resource (missing -> E_CONFIG) and
                enough headroom (quota - used - pending >= amount, else
                E_QUOTA).  Pending is incremented level by level; if any
                level fails, every level already incremented is rolled back
                to its pre-operation value.  A quota of 0 forbids any
                positive reservation.
  * confirm  -- pending -> used along the chain.  Only a reservation in
                state "pending" can be confirmed; anything else -> E_STATE.
  * release  -- decrements used along the chain.  Only a reservation in
                state "confirmed" can be released; anything else -> E_STATE.
  * Idempotency: a successful reserve caches its response under the
                idempotency key.  Replaying the same key with the same
                request returns the original response without charging
                again; replaying with a different request -> E_CONFLICT.
                Failed reserves are recorded (state "failed") for audit but
                never cached, so a client may retry after fixing the cause.
"""

from __future__ import annotations

import copy

E_QUOTA = "E_QUOTA"
E_CONFIG = "E_CONFIG"
E_STATE = "E_STATE"
E_CONFLICT = "E_CONFLICT"
E_ARGS = "E_ARGS"
E_NOTFOUND = "E_NOTFOUND"


class PolicyError(Exception):
    """Domain error raised by every tenantq operation."""

    def __init__(self, code, message, reservation_id=None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.reservation_id = reservation_id

    def to_dict(self):
        error = {"code": self.code, "message": self.message}
        if self.reservation_id is not None:
            error["reservation_id"] = self.reservation_id
        return {"ok": False, "error": error}


def _new_tenant(parent):
    return {"parent": parent, "quotas": {}, "used": {}, "pending": {}}


class Engine:
    """In-memory hierarchical quota engine with dict-based persistence."""

    def __init__(self):
        self.tenants = {}
        self.reservations = {}
        self.keys = {}
        self._seq = 0

    # ------------------------------------------------------------------
    # topology and configuration
    # ------------------------------------------------------------------
    def add_tenant(self, tenant_id, parent=None):
        if tenant_id in self.tenants:
            raise PolicyError(E_STATE, f"tenant {tenant_id!r} already exists")
        if parent is not None and parent not in self.tenants:
            raise PolicyError(E_NOTFOUND, f"parent tenant {parent!r} does not exist")
        self.tenants[tenant_id] = _new_tenant(parent)
        return {"ok": True, "tenant": tenant_id, "parent": parent}

    def set_quota(self, tenant_id, resource, limit):
        node = self.tenants.get(tenant_id)
        if node is None:
            raise PolicyError(E_NOTFOUND, f"unknown tenant {tenant_id!r}")
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 0:
            raise PolicyError(E_ARGS, "quota limit must be a non-negative integer")
        node["quotas"][resource] = limit
        return {"ok": True, "tenant": tenant_id, "resource": resource, "limit": limit}

    # ------------------------------------------------------------------
    # reservations
    # ------------------------------------------------------------------
    def reserve(self, tenant_id, resource, amount, key):
        if not isinstance(amount, int) or isinstance(amount, bool) or amount <= 0:
            raise PolicyError(E_ARGS, "amount must be a positive integer")
        chain = self._chain(tenant_id)

        request = {"tenant": tenant_id, "resource": resource, "amount": amount}
        cached = self.keys.get(key)
        if cached is not None:
            if cached["request"] != request:
                raise PolicyError(
                    E_CONFLICT,
                    f"idempotency key {key!r} was already used with different parameters",
                )
            return copy.deepcopy(cached["response"])

        reservation_id = self._next_id()
        applied = []  # (tenant_id, previous pending value or None if absent)
        try:
            for tid in chain:
                node = self.tenants[tid]
                if resource not in node["quotas"]:
                    raise PolicyError(
                        E_CONFIG,
                        f"tenant {tid!r} has no quota configured for resource {resource!r}",
                        reservation_id=reservation_id,
                    )
                limit = node["quotas"][resource]
                available = (
                    limit
                    - node["used"].get(resource, 0)
                    - node["pending"].get(resource, 0)
                )
                if available < amount:
                    raise PolicyError(
                        E_QUOTA,
                        f"insufficient quota at tenant {tid!r}: "
                        f"requested {amount}, available {available}",
                        reservation_id=reservation_id,
                    )
                applied.append((tid, node["pending"].get(resource)))
                node["pending"][resource] = node["pending"].get(resource, 0) + amount
        except PolicyError:
            # Roll back every level already incremented to its pre-op value.
            for tid, previous in applied:
                pending = self.tenants[tid]["pending"]
                if previous is None:
                    pending.pop(resource, None)
                else:
                    pending[resource] = previous
            self.reservations[reservation_id] = self._record(
                reservation_id, tenant_id, resource, amount, key, chain, "failed"
            )
            raise

        self.reservations[reservation_id] = self._record(
            reservation_id, tenant_id, resource, amount, key, chain, "pending"
        )
        response = self._reservation_status(self.reservations[reservation_id])
        self.keys[key] = {"request": request, "response": copy.deepcopy(response)}
        return response

    def confirm(self, reservation_id):
        rsv = self.reservations.get(reservation_id)
        if rsv is None:
            raise PolicyError(E_STATE, f"unknown reservation {reservation_id!r}")
        if rsv["state"] != "pending":
            raise PolicyError(
                E_STATE,
                f"reservation {reservation_id!r} is {rsv['state']}, cannot confirm",
            )
        resource = rsv["resource"]
        for tid in rsv["chain"]:
            node = self.tenants[tid]
            node["pending"][resource] -= rsv["amount"]
            node["used"][resource] = node["used"].get(resource, 0) + rsv["amount"]
        rsv["state"] = "confirmed"
        return self._reservation_status(rsv)

    def release(self, reservation_id):
        rsv = self.reservations.get(reservation_id)
        if rsv is None:
            raise PolicyError(E_STATE, f"unknown reservation {reservation_id!r}")
        if rsv["state"] != "confirmed":
            raise PolicyError(
                E_STATE,
                f"reservation {reservation_id!r} is {rsv['state']}, cannot release",
            )
        resource = rsv["resource"]
        for tid in rsv["chain"]:
            node = self.tenants[tid]
            node["used"][resource] -= rsv["amount"]
        rsv["state"] = "released"
        return self._reservation_status(rsv)

    # ------------------------------------------------------------------
    # introspection
    # ------------------------------------------------------------------
    def status(self, tenant_id=None):
        if tenant_id is not None:
            return {"ok": True, "tenant": tenant_id, **self._tenant_view(tenant_id)}
        return {
            "ok": True,
            "tenants": {tid: self._tenant_view(tid) for tid in self.tenants},
        }

    def reservation(self, reservation_id):
        rsv = self.reservations.get(reservation_id)
        if rsv is None:
            raise PolicyError(E_STATE, f"unknown reservation {reservation_id!r}")
        return self._reservation_status(rsv)

    # ------------------------------------------------------------------
    # persistence
    # ------------------------------------------------------------------
    def to_dict(self):
        return {
            "tenants": copy.deepcopy(self.tenants),
            "reservations": copy.deepcopy(self.reservations),
            "keys": copy.deepcopy(self.keys),
            "seq": self._seq,
        }

    @classmethod
    def from_dict(cls, data):
        engine = cls()
        engine.tenants = copy.deepcopy(data.get("tenants", {}))
        engine.reservations = copy.deepcopy(data.get("reservations", {}))
        engine.keys = copy.deepcopy(data.get("keys", {}))
        engine._seq = data.get("seq", 0)
        return engine

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    def _next_id(self):
        self._seq += 1
        return f"rsv-{self._seq:08d}"

    def _chain(self, tenant_id):
        if tenant_id not in self.tenants:
            raise PolicyError(E_NOTFOUND, f"unknown tenant {tenant_id!r}")
        chain = []
        tid = tenant_id
        while tid is not None:
            chain.append(tid)
            tid = self.tenants[tid]["parent"]
        return chain  # leaf -> root

    @staticmethod
    def _record(reservation_id, tenant_id, resource, amount, key, chain, state):
        return {
            "id": reservation_id,
            "tenant": tenant_id,
            "resource": resource,
            "amount": amount,
            "key": key,
            "state": state,
            "chain": list(chain),
        }

    @staticmethod
    def _reservation_status(rsv):
        return {
            "ok": True,
            "reservation_id": rsv["id"],
            "state": rsv["state"],
            "tenant": rsv["tenant"],
            "resource": rsv["resource"],
            "amount": rsv["amount"],
            "idempotency_key": rsv["key"],
        }

    def _tenant_view(self, tenant_id):
        node = self.tenants.get(tenant_id)
        if node is None:
            raise PolicyError(E_NOTFOUND, f"unknown tenant {tenant_id!r}")
        available = {
            resource: limit
            - node["used"].get(resource, 0)
            - node["pending"].get(resource, 0)
            for resource, limit in node["quotas"].items()
        }
        return {
            "parent": node["parent"],
            "quotas": copy.deepcopy(node["quotas"]),
            "used": copy.deepcopy(node["used"]),
            "pending": copy.deepcopy(node["pending"]),
            "available": available,
        }
