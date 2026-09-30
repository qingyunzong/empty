"""Acceptance E: randomized differential testing.

For random graphs with n <= 8 roles (cycles and self-loops included), random
grants and random revocation events, the engine under test must agree with an
independent reference that enumerates *all simple paths* from the subject's
assigned roles. The reference is deliberately implemented from scratch here
(including its own revocation application) so the two share no code.
"""

import json
import random
import unittest

from rbacx import load_policy

ROUNDS = 300
SEED = 20261001


def reference_check(db, user, perm):
    """Independent oracle: apply revocations, then enumerate all simple paths."""
    roles = {
        name: {
            "inherits": list(spec.get("inherits", [])),
            "allow": set(spec.get("allow", [])),
            "deny": set(spec.get("deny", [])),
        }
        for name, spec in db.get("roles", {}).items()
    }
    users = {name: list(assigned) for name, assigned in db.get("users", {}).items()}

    epoch = 0
    events = sorted(
        enumerate(db.get("revocations", [])), key=lambda pair: (pair[1]["epoch"], pair[0])
    )
    for _, event in events:
        epoch = max(epoch, event["epoch"])
        etype = event["type"]
        if etype == "role":
            name = event["role"]
            roles.pop(name, None)
            for entry in roles.values():
                if name in entry["inherits"]:
                    entry["inherits"].remove(name)
            for assigned in users.values():
                while name in assigned:
                    assigned.remove(name)
        elif etype == "edge":
            entry = roles.get(event["role"])
            if entry and event["target"] in entry["inherits"]:
                entry["inherits"].remove(event["target"])
        elif etype in ("allow", "deny"):
            entry = roles.get(event["role"])
            if entry:
                entry[etype].discard(event["perm"])
        elif etype == "assign":
            assigned = users.get(event["user"], [])
            if event["role"] in assigned:
                assigned.remove(event["role"])

    allow_sources, deny_sources = set(), set()

    def walk(node, path):
        if perm in roles[node]["allow"]:
            allow_sources.add(node)
        if perm in roles[node]["deny"]:
            deny_sources.add(node)
        for nxt in roles[node]["inherits"]:
            if nxt in roles and nxt not in path:  # simple paths only: no infinite loop
                walk(nxt, path | {nxt})

    for start in users.get(user, []):
        if start in roles:
            walk(start, {start})

    if deny_sources:
        decision = "deny"
    elif allow_sources:
        decision = "allow"
    else:
        decision = "deny"
    return {
        "decision": decision,
        "sources": {"allow": sorted(allow_sources), "deny": sorted(deny_sources)},
        "epoch": epoch,
    }


def random_db(rng):
    n = rng.randint(1, 8)
    names = [f"r{i}" for i in range(n)]
    perms = [f"p{i}" for i in range(rng.randint(1, 4))]
    roles = {}
    for name in names:
        roles[name] = {
            "inherits": [t for t in names if rng.random() < 0.3],
            "allow": [p for p in perms if rng.random() < 0.4],
            "deny": [p for p in perms if rng.random() < 0.2],
        }
    users = {
        f"u{i}": [r for r in names if rng.random() < 0.5]
        for i in range(rng.randint(1, 3))
    }
    revocations = []
    for _ in range(rng.randint(0, 6)):
        etype = rng.choice(["role", "edge", "allow", "deny", "assign"])
        event = {"epoch": rng.randint(0, 10), "type": etype}
        if etype == "role":
            event["role"] = rng.choice(names + ["ghost"])
        elif etype == "edge":
            event["role"] = rng.choice(names)
            event["target"] = rng.choice(names + ["ghost"])
        elif etype in ("allow", "deny"):
            event["role"] = rng.choice(names + ["ghost"])
            event["perm"] = rng.choice(perms)
        else:
            event["user"] = rng.choice(list(users) + ["ghost"])
            event["role"] = rng.choice(names + ["ghost"])
        revocations.append(event)
    return {"roles": roles, "users": users, "revocations": revocations}, perms, list(users)


class TestRandomizedDifferential(unittest.TestCase):
    def test_matches_path_enumeration_reference(self):
        rng = random.Random(SEED)
        for round_no in range(ROUNDS):
            db, perms, user_names = random_db(rng)
            policy = load_policy(json.dumps(db))
            for user in user_names + ["ghost"]:
                for perm in perms + ["ghost-perm"]:
                    expected = reference_check(db, user, perm)
                    actual = policy.check(user, perm)
                    self.assertEqual(
                        actual,
                        expected,
                        f"round {round_no} user={user} perm={perm}\ndb={json.dumps(db)}",
                    )


if __name__ == "__main__":
    unittest.main()
