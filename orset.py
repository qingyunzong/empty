"""Add-wins OR-Set (observed-remove set) with compaction.

Pure Python 3.11 standard library. Provides:
  - ORSet: the replicated data type (add / remove / merge / compact / contains)
  - a JSON-lines CLI: add / rem / merge / compact / contains / dump

Semantics:
  1. add(e) generates a globally unique tag (node, counter).
  2. remove(e) tombstones only the tags currently visible at this replica;
     concurrent (not yet delivered) adds survive.
  3. merge is set union of live tags minus the union of known tombstones
     (commutative, associative, idempotent).
  4. compact folds live tags that every known node has observed into a
     summary. The summary records the folded ("covered") tags so that:
       - raw tags arriving later are recognised as already represented,
       - a remove that observed exactly the covered tags still kills the
         element (compact is transparent),
       - replaying an old (already delivered) remove is a no-op and can
         never kill concurrently added or revived tags.
  5. A remove never affects adds it has not observed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys

SUMMARY_KIND = "sum"


def _tag_sort_key(tag):
    return json.dumps(list(tag), sort_keys=True)


def _is_plain_tag(tag):
    return len(tag) == 2 and isinstance(tag[0], str) and isinstance(tag[1], int)


class ORSet:
    """A single replica of an add-wins OR-Set."""

    def __init__(self, node):
        self.node = str(node)
        self.counter = 0
        self.live = {}        # element -> set of live tags (tuples)
        self.tomb = set()     # tombstoned tags
        self.summaries = {}   # element -> {digest: {"tag": tag, "covered": set}}
        self.vv = {}          # node -> max counter this replica has seen
        self.peers = {}       # node -> version vector (last known view of that node)

    def add(self, element):
        element = str(element)
        self.counter += 1
        self.vv[self.node] = self.counter
        tag = (self.node, self.counter)
        self.live.setdefault(element, set()).add(tag)
        return tag

    def remove(self, element):
        element = str(element)
        tags = self.live.get(element, set())
        self.tomb |= set(tags)
        self.live.pop(element, None)
        self._normalize()
        return len(tags)

    def contains(self, element):
        return bool(self.live.get(str(element)))

    def elements(self):
        return {e for e, tags in self.live.items() if tags}

    def merge(self, other):
        for element, sums in other.summaries.items():
            dst = self.summaries.setdefault(element, {})
            for digest, summary in sums.items():
                if digest in dst:
                    dst[digest]["covered"] |= set(summary["covered"])
                else:
                    dst[digest] = {
                        "tag": summary["tag"],
                        "covered": set(summary["covered"]),
                    }
        self.tomb |= set(other.tomb)
        for element, tags in other.live.items():
            self.live.setdefault(element, set()).update(tags)

        for node, counter in other.vv.items():
            if counter > self.vv.get(node, 0):
                self.vv[node] = counter
        for peer, pvv in other.peers.items():
            self._merge_peer_vv(peer, pvv)
        self._merge_peer_vv(other.node, other.vv)

        for tag in self.tomb:
            self._note_tag(tag)
        for tags in self.live.values():
            for tag in tags:
                self._note_tag(tag)
        for sums in self.summaries.values():
            for summary in sums.values():
                for tag in summary["covered"]:
                    self._note_tag(tag)
        if self.vv.get(self.node, 0) > self.counter:
            self.counter = self.vv[self.node]
        self._normalize()

    def compact(self):
        """Fold live plain tags observed by every known node into summaries."""
        made = 0
        for element in list(self.live):
            foldable = sorted(
                (
                    tag
                    for tag in self.live[element]
                    if _is_plain_tag(tag) and self._observed_by_all(tag)
                ),
                key=_tag_sort_key,
            )
            if not foldable:
                continue
            digest = hashlib.sha1(
                json.dumps(
                    [element, [list(tag) for tag in foldable]], sort_keys=True
                ).encode("utf-8")
            ).hexdigest()[:16]
            summary_tag = (SUMMARY_KIND, element, digest)
            sums = self.summaries.setdefault(element, {})
            if digest in sums:
                sums[digest]["covered"] |= set(foldable)
            else:
                sums[digest] = {"tag": summary_tag, "covered": set(foldable)}
            for tag in foldable:
                self.live[element].discard(tag)
            self.live[element].add(summary_tag)
            made += 1
        self._normalize()
        return made

    def _note_tag(self, tag):
        if _is_plain_tag(tag):
            node, counter = tag
            if counter > self.vv.get(node, 0):
                self.vv[node] = counter

    def _merge_peer_vv(self, peer, pvv):
        cur = self.peers.setdefault(str(peer), {})
        for node, counter in pvv.items():
            if counter > cur.get(node, 0):
                cur[node] = counter

    def _observed_by_all(self, tag):
        node, counter = tag
        known = set(self.vv) | set(self.peers) | {self.node}
        for peer in known:
            pvv = self.vv if peer == self.node else self.peers.get(peer, {})
            if pvv.get(node, 0) < counter:
                return False
        return True

    def _normalize(self):
        # A summary dies when every tag it covers is tombstoned (i.e. some
        # remove observed exactly those tags); record its tag as tombstoned.
        for sums in self.summaries.values():
            for summary in sums.values():
                tag = summary["tag"]
                if tag not in self.tomb and summary["covered"] <= self.tomb:
                    self.tomb.add(tag)
        # Drop live tags that are tombstoned or already represented by a
        # known summary (live or dead).
        covered_by_element = {}
        for element, sums in self.summaries.items():
            covered = set()
            for summary in sums.values():
                covered |= summary["covered"]
            covered_by_element[element] = covered
        for element in list(self.live):
            covered = covered_by_element.get(element, ())
            keep = {
                tag
                for tag in self.live[element]
                if tag not in self.tomb and tag not in covered
            }
            if keep:
                self.live[element] = keep
            else:
                del self.live[element]
        # Garbage-collect tombstones subsumed by dead summaries. Tombstones
        # covered by *live* summaries must be kept: several concurrent
        # removes may each cover only part of a summary.
        dead_covered = set()
        for sums in self.summaries.values():
            for summary in sums.values():
                if summary["tag"] in self.tomb:
                    dead_covered |= summary["covered"]
        self.tomb -= dead_covered

    def to_json(self):
        return {
            "node": self.node,
            "counter": self.counter,
            "live": {
                element: sorted((list(tag) for tag in tags), key=_tag_sort_key)
                for element, tags in sorted(self.live.items())
            },
            "tomb": sorted((list(tag) for tag in self.tomb), key=_tag_sort_key),
            "summaries": {
                element: [
                    {
                        "tag": list(summary["tag"]),
                        "covered": sorted(
                            (list(tag) for tag in summary["covered"]),
                            key=_tag_sort_key,
                        ),
                    }
                    for summary in sorted(
                        sums.values(), key=lambda s: _tag_sort_key(s["tag"])
                    )
                ]
                for element, sums in sorted(self.summaries.items())
            },
            "vv": dict(sorted(self.vv.items())),
            "peers": {
                peer: dict(sorted(pvv.items()))
                for peer, pvv in sorted(self.peers.items())
            },
        }

    @classmethod
    def from_json(cls, data):
        replica = cls(data["node"])
        replica.counter = int(data.get("counter", 0))
        replica.live = {
            str(element): {tuple(tag) for tag in tags}
            for element, tags in data.get("live", {}).items()
        }
        replica.tomb = {tuple(tag) for tag in data.get("tomb", [])}
        replica.summaries = {}
        for element, sums in data.get("summaries", {}).items():
            element = str(element)
            replica.summaries[element] = {}
            for summary in sums:
                tag = tuple(summary["tag"])
                digest = tag[2]
                replica.summaries[element][digest] = {
                    "tag": tag,
                    "covered": {tuple(t) for t in summary["covered"]},
                }
        replica.vv = {str(node): int(c) for node, c in data.get("vv", {}).items()}
        replica.peers = {
            str(peer): {str(node): int(c) for node, c in pvv.items()}
            for peer, pvv in data.get("peers", {}).items()
        }
        return replica


class CLIError(Exception):
    pass


def _load_state(path, node):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return ORSet.from_json(json.load(handle))
    except FileNotFoundError:
        if node is None:
            raise CLIError(
                f"state file {path!r} does not exist; pass --node to create it"
            )
        return ORSet(node)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise CLIError(f"cannot load state file {path!r}: {exc}") from exc


def _save_state(path, replica):
    try:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(replica.to_json(), handle, sort_keys=True)
            handle.write("\n")
    except OSError as exc:
        raise CLIError(f"cannot write state file {path!r}: {exc}") from exc


def _require(cmd, key):
    if key not in cmd:
        raise CLIError(f"missing field {key!r}")
    return cmd[key]


def _run_command(replica, cmd):
    if not isinstance(cmd, dict):
        raise CLIError("command must be a JSON object")
    op = cmd.get("op")
    if op == "add":
        tag = replica.add(_require(cmd, "e"))
        return {"ok": True, "tag": list(tag)}
    if op == "rem":
        removed = replica.remove(_require(cmd, "e"))
        return {"ok": True, "removed": removed}
    if op == "merge":
        other_path = _require(cmd, "file")
        other = _load_state(other_path, None)
        replica.merge(other)
        return {"ok": True}
    if op == "compact":
        return {"ok": True, "summaries": replica.compact()}
    if op == "contains":
        return {"ok": True, "result": replica.contains(_require(cmd, "e"))}
    if op == "dump":
        return {"ok": True, "state": replica.to_json()}
    raise CLIError(f"unknown op: {op!r}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="add-wins OR-Set replica CLI")
    parser.add_argument("state", help="path to the replica state file (JSON)")
    parser.add_argument("--node", help="node id used when creating a new state file")
    args = parser.parse_args(argv)

    try:
        replica = _load_state(args.state, args.node)
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except ValueError as exc:
                raise CLIError(f"invalid JSON line: {exc}") from exc
            result = _run_command(replica, cmd)
            print(json.dumps(result, sort_keys=True), flush=True)
        _save_state(args.state, replica)
    except CLIError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True))
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
