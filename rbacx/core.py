"""Core policy engine.

Semantics
---------
1. The role graph may contain cycles; cycles are not errors. Permissions
   propagate along every reachable inheritance edge (least fixed point over
   the reachability relation, so cycles terminate).
2. Revocation events take effect monotonically by epoch. Revoking a role
   cascades: permissions reachable *only* through that role disappear,
   while permissions reachable via other paths are kept.
3. An explicit deny always wins over any number of allows.
4. A permission granted from multiple sources records *all* sources; it is
   removed only when its source set becomes empty.
5. Undetermined subjects or permissions are not treated as explicit denies:
   they yield a default ``deny`` decision with empty sources.
"""

from __future__ import annotations

import json

ALLOW = "allow"
DENY = "deny"

_ROLE_KEYS = ("inherits", "allow", "deny")
_REVOCATION_TYPES = ("role", "edge", "allow", "deny", "assign")


class PolicyError(Exception):
    """Raised for any policy/DB problem. Carries a stable machine-readable code."""

    def __init__(self, code: str, message: str = ""):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)


def _err(code: str, message: str) -> PolicyError:
    return PolicyError(code, message)


def _is_str_list(value) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


class Policy:
    """An immutable, fully-revoked policy snapshot.

    roles: {name: {"inherits": set[str], "allow": set[str], "deny": set[str]}}
    users: {name: [role, ...]}
    epoch: highest revocation epoch applied (0 when there are no revocations)
    """

    def __init__(self, roles, users, epoch=0):
        self.roles = roles
        self.users = users
        self.epoch = epoch

    # ------------------------------------------------------------------ load

    @classmethod
    def from_db(cls, db) -> "Policy":
        if not isinstance(db, dict):
            raise _err("invalid_schema", "top-level document must be an object")
        unknown = set(db) - {"roles", "users", "revocations"}
        if unknown:
            raise _err("invalid_schema", f"unknown top-level keys: {sorted(unknown)}")

        roles = cls._parse_roles(db.get("roles", {}))
        users = cls._parse_users(db.get("users", {}), roles)
        policy = cls(roles, users, 0)
        return policy._apply_revocations(db.get("revocations", []))

    @staticmethod
    def _parse_roles(raw):
        if not isinstance(raw, dict):
            raise _err("invalid_schema", "'roles' must be an object")
        roles = {}
        for name, spec in raw.items():
            if not isinstance(name, str):
                raise _err("invalid_schema", "role names must be strings")
            if not isinstance(spec, dict):
                raise _err("invalid_schema", f"role '{name}' must be an object")
            unknown = set(spec) - set(_ROLE_KEYS)
            if unknown:
                raise _err("invalid_schema", f"role '{name}' has unknown keys: {sorted(unknown)}")
            entry = {}
            for key in _ROLE_KEYS:
                value = spec.get(key, [])
                if not _is_str_list(value):
                    raise _err("invalid_schema", f"role '{name}': '{key}' must be a list of strings")
                entry[key] = set(value)
            roles[name] = entry
        for name, entry in roles.items():
            for target in entry["inherits"]:
                if target not in roles:
                    raise _err("unknown_role", f"role '{name}' inherits unknown role '{target}'")
        return roles

    @staticmethod
    def _parse_users(raw, roles):
        if not isinstance(raw, dict):
            raise _err("invalid_schema", "'users' must be an object")
        users = {}
        for name, assigned in raw.items():
            if not isinstance(name, str) or not _is_str_list(assigned):
                raise _err("invalid_schema", f"user '{name}' must map to a list of role names")
            # Undetermined assignments are ignored, not treated as denies.
            users[name] = [role for role in assigned if role in roles]
        return users

    # ----------------------------------------------------------- revocations

    def _apply_revocations(self, raw) -> "Policy":
        if not isinstance(raw, list):
            raise _err("invalid_schema", "'revocations' must be a list")
        events = []
        for index, event in enumerate(raw):
            if not isinstance(event, dict):
                raise _err("invalid_schema", f"revocation #{index} must be an object")
            epoch = event.get("epoch")
            if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch < 0:
                raise _err("invalid_epoch", f"revocation #{index} has invalid epoch {epoch!r}")
            etype = event.get("type")
            if etype not in _REVOCATION_TYPES:
                raise _err("invalid_schema", f"revocation #{index} has unknown type {etype!r}")
            events.append((epoch, index, event))
        # Monotonic by epoch; stable order for equal epochs.
        events.sort(key=lambda item: (item[0], item[1]))

        roles = {name: {key: set(entry[key]) for key in _ROLE_KEYS} for name, entry in self.roles.items()}
        users = {name: list(assigned) for name, assigned in self.users.items()}
        epoch = self.epoch
        for event_epoch, _, event in events:
            epoch = max(epoch, event_epoch)
            self._apply_one(roles, users, event)
        return Policy(roles, users, epoch)

    @staticmethod
    def _apply_one(roles, users, event) -> None:
        etype = event["type"]
        if etype == "role":
            name = event.get("role")
            if not isinstance(name, str):
                raise _err("invalid_schema", "role revocation requires string 'role'")
            if name not in roles:
                return  # already gone: idempotent no-op
            del roles[name]
            for entry in roles.values():
                entry["inherits"].discard(name)
            for assigned in users.values():
                while name in assigned:
                    assigned.remove(name)
        elif etype == "edge":
            role, target = event.get("role"), event.get("target")
            if not isinstance(role, str) or not isinstance(target, str):
                raise _err("invalid_schema", "edge revocation requires string 'role' and 'target'")
            if role in roles:
                roles[role]["inherits"].discard(target)
        elif etype in ("allow", "deny"):
            role, perm = event.get("role"), event.get("perm")
            if not isinstance(role, str) or not isinstance(perm, str):
                raise _err("invalid_schema", f"{etype} revocation requires string 'role' and 'perm'")
            if role in roles:
                roles[role][etype].discard(perm)
        elif etype == "assign":
            user, role = event.get("user"), event.get("role")
            if not isinstance(user, str) or not isinstance(role, str):
                raise _err("invalid_schema", "assign revocation requires string 'user' and 'role'")
            if user in users and role in users[user]:
                users[user].remove(role)

    # ------------------------------------------------------------- evaluation

    def _reachable_roles(self, user: str):
        """Least fixed point of role reachability; terminates on cycles."""
        seen = {role for role in self.users.get(user, ()) if role in self.roles}
        stack = list(seen)
        while stack:
            role = stack.pop()
            for nxt in self.roles[role]["inherits"]:
                if nxt not in seen and nxt in self.roles:
                    seen.add(nxt)
                    stack.append(nxt)
        return seen

    def effective(self, user: str):
        """Return {"allow": {perm: {role, ...}}, "deny": {perm: {role, ...}}}."""
        allows, denies = {}, {}
        for role in self._reachable_roles(user):
            for perm in self.roles[role]["allow"]:
                allows.setdefault(perm, set()).add(role)
            for perm in self.roles[role]["deny"]:
                denies.setdefault(perm, set()).add(role)
        return {"allow": allows, "deny": denies}

    def check(self, user: str, perm: str) -> dict:
        eff = self.effective(user)
        allow_sources = sorted(eff["allow"].get(perm, ()))
        deny_sources = sorted(eff["deny"].get(perm, ()))
        if deny_sources:
            decision = "deny"  # explicit deny wins over any allow
        elif allow_sources:
            decision = "allow"
        else:
            decision = "deny"  # undetermined: default deny, empty sources
        return {
            "decision": decision,
            "sources": {"allow": allow_sources, "deny": deny_sources},
            "epoch": self.epoch,
        }


def load_policy(text: str) -> Policy:
    """Parse a JSON policy document into a Policy."""
    try:
        db = json.loads(text)
    except json.JSONDecodeError as exc:
        raise _err("invalid_json", str(exc))
    return Policy.from_db(db)
