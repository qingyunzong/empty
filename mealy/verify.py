"""Certificate checker for adaptive distinguishing trees.

Every branch of the candidate tree is replayed against the machine: at each
internal node the outputs of all remaining candidate states are computed,
the children must cover exactly the observed outputs, and every leaf must
be reached with exactly one candidate state left, labelled with that state.
"""
from __future__ import annotations


def check_certificate(machine, tree, initials):
    """Replay ``tree`` for the candidate set ``initials`` and validate it."""
    errors = []
    stats = {"nodes": 0, "leaves": 0, "depth": 0}
    initials = list(initials)
    if len(set(initials)) != len(initials):
        errors.append("duplicate initial states")
    for state in initials:
        if state not in machine.states:
            errors.append(f"unknown initial state {state!r}")
    if errors:
        return {"valid": False, "errors": errors, "stats": stats}

    def rec(config, node, path, depth):
        stats["nodes"] += 1
        stats["depth"] = max(stats["depth"], depth)
        if not isinstance(node, dict):
            errors.append(f"{path or '<root>'}: tree node is not an object")
            return
        kind = node.get("type")
        if kind == "leaf":
            stats["leaves"] += 1
            if len(config) != 1:
                errors.append(
                    f"{path or '<root>'}: leaf reached with "
                    f"{len(config)} candidates {sorted(config)}"
                )
            else:
                init = next(iter(config))
                if node.get("state") != init:
                    errors.append(
                        f"{path or '<root>'}: leaf labels {node.get('state')!r} "
                        f"but the remaining candidate is {init!r}"
                    )
            return
        if kind != "node":
            errors.append(f"{path or '<root>'}: unknown node type {kind!r}")
            return
        inp = node.get("input")
        if inp not in machine.inputs:
            errors.append(f"{path or '<root>'}: unknown input {inp!r}")
            return
        if len(config) < 2:
            errors.append(
                f"{path or '<root>'}: internal node with fewer than 2 candidates"
            )
        children = node.get("children")
        if not isinstance(children, dict):
            errors.append(f"{path or '<root>'}: 'children' must be an object")
            return
        groups = {}
        for init, cur in config.items():
            out = machine.output(cur, inp)
            groups.setdefault(out, {})[init] = machine.successor(cur, inp)
        missing = sorted(set(groups) - set(children))
        extra = sorted(set(children) - set(groups))
        if missing:
            errors.append(f"{path or '<root>'}: missing branches for outputs {missing}")
        if extra:
            errors.append(f"{path or '<root>'}: unexpected branches for outputs {extra}")
        for out, sub in groups.items():
            curs = list(sub.values())
            if len(set(curs)) != len(curs):
                errors.append(f"{path}/{out}: candidates merge into the same state")
            if out in children:
                rec(sub, children[out], f"{path}/{out}", depth + 1)

    rec({s: s for s in initials}, tree, "", 0)
    return {"valid": not errors, "errors": errors, "stats": stats}
