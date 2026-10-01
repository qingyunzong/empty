"""Anti-entropy reconciliation: build and apply pull/push/conflict plans.

Round model: each round exchanges at most `max_keys_per_round` key summaries
(both directions count), at most `max_rounds` rounds. If differing buckets
remain unprocessed, the plan is INCOMPLETE and carries only the safely
computed prefix.
"""

from . import digest as digest_mod
from . import version

DEFAULT_MAX_ROUNDS = 8
DEFAULT_MAX_KEYS_PER_ROUND = 32


def _bucket_keys(rep, bucket):
    out = {}
    for skey, entry in rep["data"].items():
        key = int(skey)
        if digest_mod.bucket_of(key) == bucket:
            out[key] = entry
    return out


def _resolve_bucket(a_entries, b_entries, plan):
    for key in sorted(set(a_entries) | set(b_entries)):
        ea = a_entries.get(key)
        eb = b_entries.get(key)
        if ea is not None and eb is None:
            plan["push"].append({"key": key, "value": ea["value"], "vv": ea["vv"]})
        elif eb is not None and ea is None:
            plan["pull"].append({"key": key, "value": eb["value"], "vv": eb["vv"]})
        else:
            rel = version.compare(ea["vv"], eb["vv"])
            if rel == version.GT:
                plan["push"].append({"key": key, "value": ea["value"], "vv": ea["vv"]})
            elif rel == version.LT:
                plan["pull"].append({"key": key, "value": eb["value"], "vv": eb["vv"]})
            elif rel == version.CONCURRENT:
                plan["conflict"].append(
                    {
                        "key": key,
                        "a": {"value": ea["value"], "vv": ea["vv"]},
                        "b": {"value": eb["value"], "vv": eb["vv"]},
                    }
                )
            # EQ: identical, nothing to exchange


def build_plan(a, b, max_rounds=DEFAULT_MAX_ROUNDS,
               max_keys_per_round=DEFAULT_MAX_KEYS_PER_ROUND):
    """Diff replica a against replica b and produce a reconciliation plan.

    pull: entries a should fetch from b; push: entries a should send to b;
    conflict: concurrent keys kept unresolved on both sides.
    """
    plan = {
        "status": "OK",
        "rounds": 0,
        "messages": 0,
        "pull": [],
        "push": [],
        "conflict": [],
        "pending_buckets": [],
    }
    dig_a = digest_mod.replica_digests(a)
    dig_b = digest_mod.replica_digests(b)
    diff_buckets = [bk for bk in range(digest_mod.NUM_BUCKETS) if dig_a[bk] != dig_b[bk]]

    round_no = 0
    budget = max_keys_per_round
    for bk in diff_buckets:
        a_entries = _bucket_keys(a, bk)
        b_entries = _bucket_keys(b, bk)
        cost = len(a_entries) + len(b_entries)  # summaries exchanged both ways
        while cost > budget:
            if round_no + 1 >= max_rounds:
                plan["status"] = "INCOMPLETE"
                plan["pending_buckets"] = diff_buckets[diff_buckets.index(bk):]
                plan["rounds"] = round_no + 1 if plan["messages"] else 0
                return plan
            round_no += 1
            budget = max_keys_per_round
        budget -= cost
        plan["messages"] += cost
        _resolve_bucket(a_entries, b_entries, plan)

    if plan["messages"]:
        plan["rounds"] = round_no + 1
    return plan


def _safe_put(rep, key, entry, conflicts_out):
    """Apply a remote entry only if it dominates or is absent; concurrent
    writes are diverted to the conflict list (never silently overwritten)."""
    skey = str(key)
    existing = rep["data"].get(skey)
    if existing is None:
        rep["data"][skey] = {"value": entry["value"], "vv": dict(entry["vv"])}
        return "applied"
    rel = version.compare(existing["vv"], entry["vv"])
    if rel in (version.LT, version.EQ):
        rep["data"][skey] = {"value": entry["value"], "vv": dict(entry["vv"])}
        return "applied"
    if rel == version.CONCURRENT:
        conflicts_out.append(key)
        return "conflict"
    return "skipped"  # local version already newer


def apply_plan(a, b, plan):
    """Apply plan between replicas a and b (mutates both). Returns summary."""
    applied = 0
    extra_conflicts = []
    for entry in plan.get("pull", []):
        if _safe_put(a, entry["key"], entry, extra_conflicts) == "applied":
            applied += 1
    for entry in plan.get("push", []):
        if _safe_put(b, entry["key"], entry, extra_conflicts) == "applied":
            applied += 1

    conflicts = sorted(plan.get("conflict", []), key=lambda c: c["key"])
    shared = [dict(c) for c in conflicts]
    a["conflicts"] = [dict(c) for c in shared]
    b["conflicts"] = [dict(c) for c in shared]
    return {
        "status": plan.get("status", "OK"),
        "applied": applied,
        "conflicts": len(conflicts),
        "pending_buckets": plan.get("pending_buckets", []),
    }
