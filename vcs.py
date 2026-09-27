#!/usr/bin/env python3
"""minivcs: a tiny commit/rebase tool.

Commit objects: {parents, message, tree(path -> text)} stored as JSON,
content-addressed by sha1. Commands: init, commit, rebase, resolve,
continue, abort. Exit codes: 0 success, 1 conflict, 2 error.
"""
import argparse
import hashlib
import json
import os
import sys


class VcsError(Exception):
    pass


# ---------- storage ----------

def init_repo(path):
    os.makedirs(os.path.join(path, "commits"), exist_ok=True)
    os.makedirs(os.path.join(path, "refs"), exist_ok=True)


def require_repo(path):
    if not os.path.isdir(os.path.join(path, "commits")):
        raise VcsError("not a repository: %s" % path)


def commit_path(repo, cid):
    return os.path.join(repo, "commits", cid)


def load_commit(repo, cid):
    with open(commit_path(repo, cid)) as f:
        return json.load(f)


def store_commit(repo, parents, message, tree):
    obj = {
        "parents": list(parents),
        "message": message,
        "tree": dict(sorted(tree.items())),
    }
    data = json.dumps(obj, sort_keys=True).encode("utf-8")
    cid = hashlib.sha1(data).hexdigest()
    if not os.path.exists(commit_path(repo, cid)):
        with open(commit_path(repo, cid), "w") as f:
            json.dump(obj, f, sort_keys=True)
    return cid


def ref_path(repo, name):
    return os.path.join(repo, "refs", name)


def read_ref(repo, name):
    p = ref_path(repo, name)
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return f.read().strip()


def write_ref(repo, name, cid):
    with open(ref_path(repo, name), "w") as f:
        f.write(cid + "\n")


def state_path(repo):
    return os.path.join(repo, "rebase_state.json")


def load_state(repo):
    with open(state_path(repo)) as f:
        return json.load(f)


def save_state(repo, state):
    with open(state_path(repo), "w") as f:
        json.dump(state, f, indent=2, sort_keys=True)


def tree_of(repo, cid):
    return dict(load_commit(repo, cid)["tree"])


# ---------- graph ----------

def ancestors(repo, cid):
    """Set of commit ids reachable from cid (inclusive)."""
    seen = set()
    stack = [cid]
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(load_commit(repo, cur)["parents"])
    return seen


def lowest_common_ancestors(repo, a, b):
    """Common ancestors that are not ancestors of any other common ancestor."""
    common = ancestors(repo, a) & ancestors(repo, b)
    lowest = []
    for c in common:
        if not any(c != d and c in ancestors(repo, d) for d in common):
            lowest.append(c)
    return sorted(lowest)


def topo_order(repo, commits):
    """Parents before children; deterministic."""
    remaining = set(commits)
    order = []
    while remaining:
        ready = sorted(
            c for c in remaining
            if all(p not in remaining for p in load_commit(repo, c)["parents"])
        )
        if not ready:
            raise VcsError("cycle in commit graph")
        order.extend(ready)
        remaining -= set(ready)
    return order


# ---------- merge ----------

def merge_trees(base, ours, theirs):
    """Three-way per-path merge. Returns (merged_tree, conflict_paths)."""
    merged = {}
    conflicts = []
    for p in sorted(set(base) | set(ours) | set(theirs)):
        b = base.get(p)
        o = ours.get(p)
        t = theirs.get(p)
        if o == t:
            if o is not None:
                merged[p] = o
        elif b == o:  # only theirs changed (incl. delete)
            if t is not None:
                merged[p] = t
        elif b == t:  # only ours changed (incl. delete)
            if o is not None:
                merged[p] = o
        else:  # both changed differently, or modify/delete
            conflicts.append(p)
    return merged, conflicts


# ---------- rebase engine ----------

def run_replay(repo, state, fail_before_ref=None):
    """Replay state['queue'] onto state['head']. Returns exit code."""
    while state["queue"]:
        cid = state["queue"][0]
        cobj = load_commit(repo, cid)
        if cobj["parents"]:
            base = tree_of(repo, cobj["parents"][0])
        else:
            base = {}
        ours = tree_of(repo, state["head"])
        resolutions = state["resolutions"] if state["current"] == cid else {}
        merged, conflicts = merge_trees(base, ours, cobj["tree"])
        unresolved = [p for p in conflicts if p not in resolutions]
        if unresolved:
            state["current"] = cid
            state["conflicts"] = unresolved
            save_state(repo, state)
            print("conflict at commit %s (%s): %s"
                  % (cid, cobj["message"], ", ".join(unresolved)))
            return 1
        for p in conflicts:  # all resolved
            merged[p] = resolutions[p]
        new_id = store_commit(repo, [state["head"]], cobj["message"], merged)
        state["done"].append(new_id)
        state["head"] = new_id
        state["queue"].pop(0)
        state["current"] = None
        state["conflicts"] = []
        state["resolutions"] = {}
        save_state(repo, state)
        if fail_before_ref is not None and len(state["done"]) == fail_before_ref:
            print("simulated crash after persisting replayed commit #%d "
                  "(%s), before writing branch ref" % (fail_before_ref, new_id))
            return 2
    write_ref(repo, state["branch"], state["head"])
    os.remove(state_path(repo))
    print("rebase complete: %s -> %s" % (state["branch"], state["head"]))
    return 0


def cmd_rebase(args):
    repo = args.repo
    require_repo(repo)
    if os.path.exists(state_path(repo)):
        raise VcsError("a rebase is already in progress (continue or abort)")
    branch, onto = args.branch, args.onto
    if branch == onto:
        raise VcsError("branch and --onto must differ")
    f_head = read_ref(repo, branch)
    m_head = read_ref(repo, onto)
    if f_head is None:
        raise VcsError("unknown branch: %s" % branch)
    if m_head is None:
        raise VcsError("unknown branch: %s" % onto)
    m_anc = ancestors(repo, m_head)
    if f_head in m_anc:  # fast-forward
        write_ref(repo, branch, m_head)
        print("fast-forward: %s -> %s" % (branch, m_head))
        return 0
    f_anc = ancestors(repo, f_head)
    if m_head in f_anc:  # already up to date
        print("already up to date")
        return 0
    lcas = lowest_common_ancestors(repo, f_head, m_head)
    if len(lcas) > 1:
        raise VcsError("no unique lowest common ancestor: %s" % lcas)
    # No common ancestor -> empty tree as base; replay everything from F.
    replay = topo_order(repo, f_anc - m_anc)
    state = {
        "branch": branch,
        "onto": onto,
        "original_head": f_head,
        "queue": replay,
        "done": [],
        "head": m_head,
        "current": None,
        "conflicts": [],
        "resolutions": {},
    }
    save_state(repo, state)
    return run_replay(repo, state, args.fail_before_ref)


def cmd_continue(args):
    repo = args.repo
    require_repo(repo)
    if not os.path.exists(state_path(repo)):
        raise VcsError("no rebase in progress")
    return run_replay(repo, load_state(repo))


def cmd_resolve(args):
    repo = args.repo
    require_repo(repo)
    if not os.path.exists(state_path(repo)):
        raise VcsError("no rebase in progress")
    state = load_state(repo)
    if not state["current"]:
        raise VcsError("no conflict to resolve")
    for item in args.set or []:
        path, _, value = item.partition("=")
        if path not in state["conflicts"]:
            raise VcsError("path not in conflict: %s" % path)
        state["resolutions"][path] = value
    save_state(repo, state)
    print("resolved: %s" % ", ".join(sorted(state["resolutions"])))
    return 0


def cmd_abort(args):
    repo = args.repo
    require_repo(repo)
    if not os.path.exists(state_path(repo)):
        raise VcsError("no rebase in progress")
    state = load_state(repo)
    write_ref(repo, state["branch"], state["original_head"])
    os.remove(state_path(repo))
    print("aborted: %s restored to %s" % (state["branch"], state["original_head"]))
    return 0


# ---------- basic commands ----------

def cmd_init(args):
    init_repo(args.repo)
    print("initialized repository in %s" % args.repo)
    return 0


def cmd_commit(args):
    repo = args.repo
    require_repo(repo)
    parents = list(args.parent or [])
    if not parents:
        head = read_ref(repo, args.branch)
        if head is not None:
            parents = [head]
    tree = tree_of(repo, parents[0]) if parents else {}
    for extra in parents[1:]:  # merge commit: union, first parent wins
        for path, value in tree_of(repo, extra).items():
            tree.setdefault(path, value)
    for item in args.set or []:
        path, _, value = item.partition("=")
        tree[path] = value
    for path in args.delete or []:
        tree.pop(path, None)
    cid = store_commit(repo, parents, args.message, tree)
    write_ref(repo, args.branch, cid)
    print(cid)
    return 0


def cmd_show(args):
    repo = args.repo
    require_repo(repo)
    cid = read_ref(repo, args.ref) or args.ref
    print(json.dumps(load_commit(repo, cid), indent=2, sort_keys=True))
    return 0


# ---------- CLI ----------

def build_parser():
    parser = argparse.ArgumentParser(prog="vcs")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def add(name, fn):
        sp = sub.add_parser(name)
        sp.add_argument("--repo", default=".vcs")
        sp.set_defaults(fn=fn)
        return sp

    add("init", cmd_init)

    sp = add("commit", cmd_commit)
    sp.add_argument("--branch", required=True)
    sp.add_argument("-m", "--message", default="")
    sp.add_argument("--parent", action="append")
    sp.add_argument("--set", action="append", metavar="PATH=VALUE")
    sp.add_argument("--delete", action="append", metavar="PATH")

    sp = add("rebase", cmd_rebase)
    sp.add_argument("--branch", required=True)
    sp.add_argument("--onto", required=True)
    sp.add_argument("--fail-before-ref", type=int, default=None)

    sp = add("resolve", cmd_resolve)
    sp.add_argument("--set", action="append", metavar="PATH=VALUE")

    add("continue", cmd_continue)
    add("abort", cmd_abort)

    sp = add("show", cmd_show)
    sp.add_argument("--ref", required=True)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.fn(args)
    except VcsError as e:
        print("error: %s" % e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
