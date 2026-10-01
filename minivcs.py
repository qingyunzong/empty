#!/usr/bin/env python3
"""minivcs - a tiny content-addressed version control system.

Commit objects: {parents: [hash...], message: str, tree: {path: text}}.
Commands: init, commit, rebase --branch F --onto M, resolve, continue, abort.

Exit codes: 0 success, 1 conflict, 2 error.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

EXIT_OK = 0
EXIT_CONFLICT = 1
EXIT_ERROR = 2

STATE_FILE = "rebase_state.json"


class RepoError(Exception):
    pass


class Repo:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.dir = os.path.join(self.root, ".minivcs")
        self.objects_dir = os.path.join(self.dir, "objects")
        self.refs_dir = os.path.join(self.dir, "refs")

    def exists(self):
        return os.path.isdir(self.dir)

    def require(self):
        if not self.exists():
            raise RepoError("not a minivcs repository (run 'init' first)")

    # ---- objects ----
    def object_path(self, h):
        return os.path.join(self.objects_dir, h)

    def store_commit(self, parents, message, tree):
        obj = {"parents": list(parents), "message": message,
               "tree": dict(sorted(tree.items()))}
        data = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()
        h = hashlib.sha1(data).hexdigest()
        path = self.object_path(h)
        if not os.path.exists(path):
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
        return h

    def load_commit(self, h):
        path = self.object_path(h)
        if not os.path.exists(path):
            raise RepoError("missing object %s" % h)
        with open(path, "rb") as f:
            return json.loads(f.read().decode())

    def list_objects(self):
        if not os.path.isdir(self.objects_dir):
            return []
        return sorted(os.listdir(self.objects_dir))

    # ---- refs ----
    def read_ref(self, name):
        path = os.path.join(self.refs_dir, name)
        if not os.path.exists(path):
            raise RepoError("unknown branch '%s'" % name)
        with open(path) as f:
            return f.read().strip()

    def write_ref(self, name, h):
        tmp = os.path.join(self.refs_dir, name + ".tmp")
        with open(tmp, "w") as f:
            f.write(h + "\n")
        os.replace(tmp, os.path.join(self.refs_dir, name))

    # ---- rebase state ----
    def state_path(self):
        return os.path.join(self.dir, STATE_FILE)

    def has_state(self):
        return os.path.exists(self.state_path())

    def save_state(self, state):
        tmp = self.state_path() + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f, indent=2, sort_keys=True)
        os.replace(tmp, self.state_path())

    def load_state(self):
        if not self.has_state():
            raise RepoError("no rebase in progress")
        with open(self.state_path()) as f:
            return json.load(f)

    def clear_state(self):
        if self.has_state():
            os.remove(self.state_path())


# ---- DAG helpers ----

def ancestors(repo, tip):
    """Set of commits reachable from tip (including tip itself)."""
    seen = set()
    stack = [tip]
    while stack:
        h = stack.pop()
        if h is None or h in seen:
            continue
        seen.add(h)
        stack.extend(repo.load_commit(h)["parents"])
    return seen


def find_lca(repo, a, b):
    """Unique lowest common ancestor of a and b, or None if disjoint.

    'Lowest' means: a common ancestor that is not itself an ancestor of any
    other common ancestor. Deterministic if several qualify.
    """
    common = ancestors(repo, a) & ancestors(repo, b)
    if not common:
        return None
    anc_cache = {}

    def anc(h):
        if h not in anc_cache:
            anc_cache[h] = ancestors(repo, h)
        return anc_cache[h]

    lowest = [c for c in common
              if not any(c != other and c in anc(other) for other in common)]
    return sorted(lowest)[0]


def commits_to_replay(repo, tip, base):
    """Commits reachable from tip but not from base, parents before children."""
    excluded = ancestors(repo, base) if base else set()
    order = []
    seen = set()

    def visit(h):
        if h is None or h in seen or h in excluded:
            return
        seen.add(h)
        for p in sorted(repo.load_commit(h)["parents"]):
            visit(p)
        order.append(h)

    visit(tip)
    return order


# ---- three-way merge ----

def merge_trees(base, ours, theirs):
    """Per-path three-way merge. Returns (merged_tree, conflict_paths)."""
    merged = {}
    conflicts = []
    for path in sorted(set(base) | set(ours) | set(theirs)):
        b = base.get(path)
        o = ours.get(path)
        t = theirs.get(path)
        if o == t:
            value = o
        elif b == o:      # only theirs changed
            value = t
        elif b == t:      # only ours changed
            value = o
        else:             # both changed differently / modify vs delete
            conflicts.append(path)
            continue
        if value is not None:
            merged[path] = value
    return merged, conflicts


def merge_for_commit(repo, state, commit_hash):
    """Compute the three-way merge for replaying commit_hash onto new_tip."""
    obj = repo.load_commit(commit_hash)
    if obj["parents"]:
        base_tree = repo.load_commit(obj["parents"][0])["tree"]
    else:
        base_tree = {}
    ours_tree = repo.load_commit(state["new_tip"])["tree"]
    return obj, merge_trees(base_tree, ours_tree, obj["tree"])


# ---- rebase engine ----

def _persist_replayed(repo, state, obj, merged):
    h = repo.store_commit([state["new_tip"]], obj["message"], merged)
    state["replayed"].append(h)
    state["new_tip"] = h
    state["remaining"].pop(0)
    repo.save_state(state)
    return h


def _crash_requested(state):
    k = state.get("fail_before_ref")
    return k is not None and k == len(state["replayed"])


def replay_remaining(repo, state, out):
    while state["remaining"]:
        c = state["remaining"][0]
        obj, (merged, conflicts) = merge_for_commit(repo, state, c)
        if conflicts:
            state["current"] = c
            state["conflicts"] = conflicts
            state["resolutions"] = {}
            repo.save_state(state)
            print("conflict: resolve paths: %s" % ", ".join(conflicts), file=out)
            return EXIT_CONFLICT
        _persist_replayed(repo, state, obj, merged)
        if _crash_requested(state):
            print("simulated crash: commit persisted, branch ref not written",
                  file=sys.stderr)
            return EXIT_ERROR
    repo.write_ref(state["branch"], state["new_tip"])
    repo.clear_state()
    print("rebase complete: %s -> %s" % (state["branch"], state["new_tip"]),
          file=out)
    return EXIT_OK


def cmd_init(repo, out):
    if repo.exists():
        raise RepoError("repository already exists")
    os.makedirs(repo.objects_dir)
    os.makedirs(repo.refs_dir)
    print("initialized empty repository in %s" % repo.dir, file=out)
    return EXIT_OK


def cmd_commit(repo, branch, message, sets, dels, parents, out):
    repo.require()
    if parents:
        parent_list = list(parents)
    else:
        try:
            parent_list = [repo.read_ref(branch)]
        except RepoError:
            parent_list = []
    tree = {}
    if parent_list:
        tree = dict(repo.load_commit(parent_list[0])["tree"])
    for path, value in sets:
        tree[path] = value
    for path in dels:
        tree.pop(path, None)
    h = repo.store_commit(parent_list, message, tree)
    repo.write_ref(branch, h)
    print(h, file=out)
    return EXIT_OK


def cmd_rebase(repo, branch, onto, fail_before_ref, out):
    repo.require()
    if repo.has_state():
        raise RepoError("rebase already in progress (continue or abort)")
    f_tip = repo.read_ref(branch)
    m_tip = repo.read_ref(onto)
    lca = find_lca(repo, f_tip, m_tip)
    queue = commits_to_replay(repo, f_tip, lca)
    state = {
        "branch": branch,
        "onto": onto,
        "original_tip": f_tip,
        "new_tip": m_tip,
        "replayed": [],
        "remaining": queue,
        "current": None,
        "conflicts": [],
        "resolutions": {},
        "fail_before_ref": fail_before_ref,
    }
    if not queue:
        repo.write_ref(branch, m_tip)  # fast-forward
        print("fast-forward: %s -> %s" % (branch, m_tip), file=out)
        return EXIT_OK
    repo.save_state(state)
    return replay_remaining(repo, state, out)


def cmd_resolve(repo, sets, dels, out):
    repo.require()
    state = repo.load_state()
    if not state["current"]:
        raise RepoError("no conflicted commit to resolve")
    for path, value in sets:
        state["resolutions"][path] = value
    for path in dels:
        state["resolutions"][path] = None
    repo.save_state(state)
    print("recorded resolutions for: %s"
          % ", ".join(sorted(state["resolutions"])), file=out)
    return EXIT_OK


def cmd_continue(repo, out):
    repo.require()
    state = repo.load_state()
    if state["current"]:
        obj, (merged, conflicts) = merge_for_commit(repo, state,
                                                    state["current"])
        unresolved = [p for p in conflicts if p not in state["resolutions"]]
        if unresolved:
            print("conflict: unresolved paths: %s" % ", ".join(unresolved),
                  file=out)
            return EXIT_CONFLICT
        for path, value in state["resolutions"].items():
            if value is None:
                merged.pop(path, None)
            else:
                merged[path] = value
        _persist_replayed(repo, state, obj, merged)
        state["current"] = None
        state["conflicts"] = []
        state["resolutions"] = {}
        repo.save_state(state)
        if _crash_requested(state):
            print("simulated crash: commit persisted, branch ref not written",
                  file=sys.stderr)
            return EXIT_ERROR
    return replay_remaining(repo, state, out)


def cmd_abort(repo, out):
    repo.require()
    state = repo.load_state()
    repo.write_ref(state["branch"], state["original_tip"])
    repo.clear_state()
    print("rebase aborted: %s restored to %s"
          % (state["branch"], state["original_tip"]), file=out)
    return EXIT_OK


# ---- CLI ----

def _parse_set(pair):
    if "=" not in pair:
        raise RepoError("--set expects PATH=VALUE, got %r" % pair)
    return tuple(pair.split("=", 1))


def build_parser():
    parser = argparse.ArgumentParser(prog="minivcs")
    parser.add_argument("--repo", default=".", help="repository root directory")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init")

    p = sub.add_parser("commit")
    p.add_argument("--branch", required=True)
    p.add_argument("-m", "--message", default="")
    p.add_argument("--set", action="append", default=[], metavar="PATH=VALUE")
    p.add_argument("--del", dest="delete", action="append", default=[],
                   metavar="PATH")
    p.add_argument("--parent", action="append", default=[], metavar="HASH")

    p = sub.add_parser("rebase")
    p.add_argument("--branch", required=True)
    p.add_argument("--onto", required=True)
    p.add_argument("--fail-before-ref", type=int, default=None, metavar="K")

    p = sub.add_parser("resolve")
    p.add_argument("--set", action="append", default=[], metavar="PATH=VALUE")
    p.add_argument("--del", dest="delete", action="append", default=[],
                   metavar="PATH")

    sub.add_parser("continue")
    sub.add_parser("abort")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    repo = Repo(args.repo)
    try:
        if args.command == "init":
            return cmd_init(repo, sys.stdout)
        if args.command == "commit":
            return cmd_commit(repo, args.branch, args.message,
                              [_parse_set(s) for s in args.set],
                              args.delete, args.parent, sys.stdout)
        if args.command == "rebase":
            return cmd_rebase(repo, args.branch, args.onto,
                              args.fail_before_ref, sys.stdout)
        if args.command == "resolve":
            return cmd_resolve(repo, [_parse_set(s) for s in args.set],
                               args.delete, sys.stdout)
        if args.command == "continue":
            return cmd_continue(repo, sys.stdout)
        if args.command == "abort":
            return cmd_abort(repo, sys.stdout)
    except RepoError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EXIT_ERROR
    return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
