"""Add-wins observed-remove set (OR-Set) CRDT with compaction.

Semantics:
  1. add(e) generates a fresh, globally unique tag (node, counter).
  2. remove(e) only tombstones the tags currently *visible* at the removing
     replica; concurrent/unknown add tags survive (add-wins).
  3. merge is the union of add-sets minus the union of remove-sets; it is
     commutative, associative and idempotent.
  4. compact folds dead tags that every node has observed into a per-element
     summary watermark {node: max_dead_counter}.  The summary keeps enough
     information to reject replays of old removes.  compact() requires a
     quiescence barrier: all nodes must have observed the folded state.
  5. A remove can never affect an add that has not been delivered to the
     removing replica.

CLI (JSON lines on stdin, one JSON line per result on stdout):
  python orset.py add       {"node": "A", "element": "x", "state": S|null}
  python orset.py rem       {"element": "x", "state": S}
  python orset.py merge     {"states": [S1, S2, ...]}
  python orset.py compact   {"state": S, "nodes": ["A", "B"]}   (nodes optional)
  python orset.py contains  {"element": "x", "state": S}
  python orset.py dump      {"state": S}
Any error (bad command, bad JSON, missing/invalid field) exits with code 4.
"""

from __future__ import annotations

import json
import sys

COMMANDS = ("add", "rem", "merge", "compact", "contains", "dump")


class ORSet:
    """State-based add-wins OR-Set.

    live:    element -> set of (node, counter) tags currently visible
    dead:    element -> set of (node, counter) tags explicitly tombstoned
    summary: element -> {node: watermark}; every tag (node, c) with
             c <= watermark is known dead without being listed in `dead`.
    """

    def __init__(self, node, counter=0, live=None, dead=None, summary=None):
        self.node = node
        self.counter = counter
        self.live = live if live is not None else {}
        self.dead = dead if dead is not None else {}
        self.summary = summary if summary is not None else {}

    # ------------------------------------------------------------------ core
    def _is_dead(self, element, tag):
        node, cnt = tag
        if cnt <= self.summary.get(element, {}).get(node, -1):
            return True
        return tag in self.dead.get(element, ())

    def _visible_tags(self, element):
        return {t for t in self.live.get(element, ()) if not self._is_dead(element, t)}

    def add(self, element):
        tag = (self.node, self.counter)
        self.counter += 1
        self.live.setdefault(element, set()).add(tag)
        return tag

    def remove(self, element):
        """Tombstone exactly the tags visible at this replica right now."""
        for tag in self._visible_tags(element):
            self.dead.setdefault(element, set()).add(tag)
            self.live[element].discard(tag)
        if not self.live.get(element):
            self.live.pop(element, None)

    def contains(self, element):
        return bool(self._visible_tags(element))

    def elements(self):
        return sorted(e for e in self._all_elements() if self.contains(e))

    def _all_elements(self):
        return set(self.live) | set(self.dead) | set(self.summary)

    def merge(self, other):
        """Union of adds minus union of removes; commutative/associative/idempotent."""
        out = ORSet(self.node)
        out.counter = max(self.counter, other.counter)
        for element in self._all_elements() | other._all_elements():
            summary = {}
            for src in (self.summary.get(element), other.summary.get(element)):
                if src:
                    for node, mark in src.items():
                        if mark > summary.get(node, -1):
                            summary[node] = mark
            dead = set(self.dead.get(element, ())) | set(other.dead.get(element, ()))
            live = set(self.live.get(element, ())) | set(other.live.get(element, ()))
            # Drop entries already covered by the merged summary.
            dead = {t for t in dead if t[1] > summary.get(t[0], -1)}
            live = {t for t in live if t[1] > summary.get(t[0], -1) and t not in dead}
            if summary:
                out.summary[element] = summary
            if dead:
                out.dead[element] = dead
            if live:
                out.live[element] = live
        return out

    def compact(self, nodes=None):
        """Fold dead tags observed by every node into summary watermarks.

        Precondition (quiescence barrier): every replica in `nodes` (or all
        replicas, when omitted) has observed this state, so no live tag
        unknown to this replica can be hidden by a watermark.  A dead tag
        (node, c) is folded only when c is below every live counter of that
        node for the element, guaranteeing the watermark cannot shadow any
        surviving add.  Replayed removes carrying folded tags stay no-ops.
        """
        for element in self._all_elements():
            summary = dict(self.summary.get(element, {}))
            live = {t for t in self.live.get(element, ()) if t[1] > summary.get(t[0], -1)}
            dead = {t for t in self.dead.get(element, ()) if t[1] > summary.get(t[0], -1)}
            min_live = {}
            for node, cnt in live:
                if cnt < min_live.get(node, cnt):
                    min_live[node] = cnt
            remaining = set()
            for node, cnt in dead:
                limit = min_live.get(node)
                if limit is None or cnt < limit:
                    if cnt > summary.get(node, -1):
                        summary[node] = cnt
                else:
                    remaining.add((node, cnt))
            if summary:
                self.summary[element] = summary
            if remaining:
                self.dead[element] = remaining
            else:
                self.dead.pop(element, None)
            if live:
                self.live[element] = live
            else:
                self.live.pop(element, None)

    # ---------------------------------------------------------- serialization
    def to_json(self):
        return {
            "node": self.node,
            "counter": self.counter,
            "live": {e: sorted([list(t) for t in tags]) for e, tags in sorted(self.live.items()) if tags},
            "dead": {e: sorted([list(t) for t in tags]) for e, tags in sorted(self.dead.items()) if tags},
            "summary": {e: dict(sorted(m.items())) for e, m in sorted(self.summary.items())},
        }

    @staticmethod
    def from_json(data):
        if not isinstance(data, dict):
            raise ValueError("state must be a JSON object")
        node = data.get("node")
        counter = data.get("counter", 0)
        if not isinstance(node, str) or not isinstance(counter, int) or counter < 0:
            raise ValueError("invalid node/counter in state")

        def parse_tags(obj, key):
            raw = obj.get(key, {})
            if not isinstance(raw, dict):
                raise ValueError(f"{key} must be an object")
            out = {}
            for element, tags in raw.items():
                if not isinstance(element, str) or not isinstance(tags, list):
                    raise ValueError(f"invalid {key} entry")
                parsed = set()
                for tag in tags:
                    if (
                        not isinstance(tag, list) or len(tag) != 2
                        or not isinstance(tag[0], str)
                        or not isinstance(tag[1], int) or tag[1] < 0
                    ):
                        raise ValueError("invalid tag")
                    parsed.add((tag[0], tag[1]))
                if parsed:
                    out[element] = parsed
            return out

        summary = {}
        raw_summary = data.get("summary", {})
        if not isinstance(raw_summary, dict):
            raise ValueError("summary must be an object")
        for element, marks in raw_summary.items():
            if not isinstance(element, str) or not isinstance(marks, dict):
                raise ValueError("invalid summary entry")
            parsed = {}
            for n, mark in marks.items():
                if not isinstance(n, str) or not isinstance(mark, int) or mark < 0:
                    raise ValueError("invalid summary watermark")
                parsed[n] = mark
            if parsed:
                summary[element] = parsed

        return ORSet(node, counter, parse_tags(data, "live"), parse_tags(data, "dead"), summary)


# ---------------------------------------------------------------------- CLI
def _require_str(req, key):
    value = req.get(key)
    if not isinstance(value, str):
        raise ValueError(f"missing or invalid field: {key}")
    return value


def _require_state(req):
    if "state" not in req:
        raise ValueError("missing field: state")
    return ORSet.from_json(req["state"])


def handle(cmd, req):
    if not isinstance(req, dict):
        raise ValueError("request must be a JSON object")
    if cmd == "add":
        state = req.get("state")
        if state is None:
            s = ORSet(_require_str(req, "node"))
        else:
            s = ORSet.from_json(state)
        s.add(_require_str(req, "element"))
        return s.to_json()
    if cmd == "rem":
        s = _require_state(req)
        s.remove(_require_str(req, "element"))
        return s.to_json()
    if cmd == "merge":
        states = req.get("states")
        if not isinstance(states, list) or not states:
            raise ValueError("missing or invalid field: states")
        merged = ORSet.from_json(states[0])
        for extra in states[1:]:
            merged = merged.merge(ORSet.from_json(extra))
        return merged.to_json()
    if cmd == "compact":
        s = _require_state(req)
        nodes = req.get("nodes")
        if nodes is not None and (not isinstance(nodes, list) or not all(isinstance(n, str) for n in nodes)):
            raise ValueError("invalid field: nodes")
        s.compact(nodes)
        return s.to_json()
    if cmd == "contains":
        s = _require_state(req)
        return {"contains": s.contains(_require_str(req, "element"))}
    if cmd == "dump":
        s = _require_state(req)
        return {"elements": s.elements(), "state": s.to_json()}
    raise ValueError(f"unknown command: {cmd}")


def main(argv):
    if len(argv) != 2 or argv[1] not in COMMANDS:
        print(f"usage: python {argv[0]} <{'|'.join(COMMANDS)}>", file=sys.stderr)
        return 4
    cmd = argv[1]
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            req = json.loads(line)
            print(json.dumps(handle(cmd, req), sort_keys=True))
    except Exception as exc:  # any malformed input -> exit 4
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
