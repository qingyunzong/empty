#!/usr/bin/env python3
"""minigit - a tiny content-addressed VCS with history rewriting.

Python 3.11 standard library only.

Commands:
  init
  commit -m MSG --file PATH=TEXT [--file PATH=TEXT ...]
  filter [--strip-prefix PREFIX] [--message-regex REGEX] [--replacement REPL]
         [--fail-after-objects] [--abort]
  log
  cat-file OID
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys

GIT_DIR = ".minigit"
OBJECTS = os.path.join(GIT_DIR, "objects")
STAGING = os.path.join(GIT_DIR, "filter-staging")
STAGING_OBJECTS = os.path.join(STAGING, "objects")
STAGING_PLAN = os.path.join(STAGING, "plan.json")

EXIT_ERROR = 1
EXIT_USAGE = 2
EXIT_FAIL_AFTER_OBJECTS = 3


def die(msg, code=EXIT_ERROR):
    print(f"fatal: {msg}", file=sys.stderr)
    sys.exit(code)


def require_repo():
    if not os.path.isdir(OBJECTS):
        die("not a minigit repository (run 'init' first)")


# ---------- object store ----------

def object_path(store, oid):
    return os.path.join(store, oid[:2], oid[2:])


def hash_object(obj_type, data):
    header = f"{obj_type} {len(data)}\0".encode("utf-8")
    return hashlib.sha1(header + data).hexdigest()


def write_object(store, obj_type, data):
    """Write an object if missing; return its content-addressed id."""
    oid = hash_object(obj_type, data)
    path = object_path(store, oid)
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(f"{obj_type} {len(data)}\0".encode("utf-8") + data)
        os.replace(tmp, path)
    return oid


def read_object(oid):
    path = object_path(OBJECTS, oid)
    if not os.path.exists(path):
        die(f"object not found: {oid}")
    with open(path, "rb") as fh:
        raw = fh.read()
    header, _, data = raw.partition(b"\0")
    obj_type = header.split(b" ", 1)[0].decode("ascii")
    return obj_type, data


# ---------- trees ----------

def build_tree(files):
    """Return (root_oid, {oid: data}) of tree objects for path -> blob-oid map."""
    objects = {}

    def rec(level_files):
        entries = []
        subdirs = {}
        for path, oid in level_files.items():
            head, sep, rest = path.partition("/")
            if sep:
                subdirs.setdefault(head, {})[rest] = oid
            else:
                entries.append(("blob", oid, head))
        for name, sub in subdirs.items():
            entries.append(("tree", rec(sub), name))
        entries.sort(key=lambda e: (e[2], e[0]))
        data = "".join(f"{kind} {oid} {name}\n"
                       for kind, oid, name in entries).encode("utf-8")
        oid = hash_object("tree", data)
        objects[oid] = data
        return oid

    root = rec(files)
    return root, objects


def flatten_tree(tree_oid, prefix=""):
    obj_type, data = read_object(tree_oid)
    if obj_type != "tree":
        die(f"object {tree_oid} is not a tree")
    files = {}
    for line in data.decode("utf-8").splitlines():
        kind, oid, name = line.split(" ", 2)
        path = prefix + name
        if kind == "blob":
            files[path] = oid
        else:
            files.update(flatten_tree(oid, path + "/"))
    return files


# ---------- commits ----------

def commit_data(tree_oid, parents, message):
    lines = [f"tree {tree_oid}"]
    lines += [f"parent {p}" for p in parents]
    return "\n".join(lines).encode("utf-8") + b"\n\n" + message.encode("utf-8")


def parse_commit(data):
    header, _, message = data.partition(b"\n\n")
    commit = {"tree": None, "parents": [], "message": message.decode("utf-8")}
    for line in header.decode("utf-8").splitlines():
        key, _, value = line.partition(" ")
        if key == "tree":
            commit["tree"] = value
        elif key == "parent":
            commit["parents"].append(value)
    return commit


# ---------- refs ----------

def head_ref():
    with open(os.path.join(GIT_DIR, "HEAD"), encoding="utf-8") as fh:
        content = fh.read().strip()
    if not content.startswith("ref: "):
        die("detached HEAD is not supported")
    return content[5:]


def read_ref(ref):
    path = os.path.join(GIT_DIR, ref)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return fh.read().strip()


def update_ref_atomic(ref, oid):
    path = os.path.join(GIT_DIR, ref)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(oid + "\n")
    os.replace(tmp, path)


# ---------- commands ----------

def cmd_init(_args):
    if os.path.isdir(GIT_DIR):
        die("repository already exists")
    os.makedirs(OBJECTS)
    os.makedirs(os.path.join(GIT_DIR, "refs", "heads"))
    with open(os.path.join(GIT_DIR, "HEAD"), "w", encoding="utf-8") as fh:
        fh.write("ref: refs/heads/main\n")
    print("initialized empty minigit repository")
    return 0


def cmd_commit(args):
    require_repo()
    files = {}
    for spec in args.file:
        path, sep, text = spec.partition("=")
        if not sep or not path:
            die(f"invalid --file spec (want PATH=TEXT): {spec!r}")
        files[path] = text
    blob_oids = {p: write_object(OBJECTS, "blob", t.encode("utf-8"))
                 for p, t in files.items()}
    tree_oid, tree_objects = build_tree(blob_oids)
    for oid, data in tree_objects.items():
        write_object(OBJECTS, "tree", data)
    tip = read_ref(head_ref())
    parents = [tip] if tip else []
    data = commit_data(tree_oid, parents, args.message)
    oid = write_object(OBJECTS, "commit", data)
    update_ref_atomic(head_ref(), oid)
    print(oid)
    return 0


def topo_order(tip):
    """All commits reachable from tip, parents before children."""
    order, seen = [], set()

    def visit(oid):
        if oid in seen:
            return
        seen.add(oid)
        obj_type, data = read_object(oid)
        if obj_type != "commit":
            die(f"object {oid} is not a commit")
        for parent in parse_commit(data)["parents"]:
            visit(parent)
        order.append(oid)

    visit(tip)
    return order


def plan_rewrite(tip, strip_prefix, pattern, replacement):
    """Map every reachable commit to its rewritten id (old id if unchanged).

    Returns (mapping, new_objects) where new_objects is {oid: (type, data)}.
    Unchanged commits contribute no new objects.
    """
    mapping = {}
    new_objects = {}
    for oid in topo_order(tip):
        commit = parse_commit(read_object(oid)[1])
        files = flatten_tree(commit["tree"])
        if strip_prefix:
            files = {p: b for p, b in files.items()
                     if not p.startswith(strip_prefix)}
        message = commit["message"]
        if pattern is not None:
            message = pattern.sub(replacement, message)
        parents = [mapping[p] for p in commit["parents"]]
        tree_oid, tree_objects = build_tree(files)
        if (tree_oid == commit["tree"] and message == commit["message"]
                and parents == commit["parents"]):
            mapping[oid] = oid  # reuse original commit, no new objects
            continue
        data = commit_data(tree_oid, parents, message)
        new_oid = hash_object("commit", data)
        for tree_id, tree_data in tree_objects.items():
            new_objects[tree_id] = ("tree", tree_data)
        new_objects[new_oid] = ("commit", data)
        mapping[oid] = new_oid
    return mapping, new_objects


def write_staging(plan, new_objects):
    shutil.rmtree(STAGING, ignore_errors=True)
    os.makedirs(STAGING_OBJECTS)
    for oid, (obj_type, data) in new_objects.items():
        write_object(STAGING_OBJECTS, obj_type, data)
    tmp = STAGING_PLAN + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(plan, fh, indent=2, sort_keys=True)
    os.replace(tmp, STAGING_PLAN)


def finalize(plan):
    """Install staged objects into the store, then atomically update the ref."""
    for root, _dirs, names in os.walk(STAGING_OBJECTS):
        for name in names:
            oid = os.path.basename(root) + name
            dst = object_path(OBJECTS, oid)
            if not os.path.exists(dst):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                os.replace(os.path.join(root, name), dst)
    update_ref_atomic(plan["branch"], plan["new_head"])
    shutil.rmtree(STAGING, ignore_errors=True)


def cmd_filter(args):
    require_repo()
    if args.abort:
        shutil.rmtree(STAGING, ignore_errors=True)
        print("filter: staging cleared, original history untouched")
        return 0
    if os.path.exists(STAGING_PLAN):
        with open(STAGING_PLAN, encoding="utf-8") as fh:
            plan = json.load(fh)
        finalize(plan)
        print(f"filter: resumed from staging, "
              f"{plan['branch']} -> {plan['new_head']}")
        return 0
    pattern = None
    if args.message_regex is not None:
        try:
            pattern = re.compile(args.message_regex)
        except re.error as exc:
            print(f"fatal: invalid regex: {exc}", file=sys.stderr)
            return EXIT_USAGE
    ref = head_ref()
    tip = read_ref(ref)
    if tip is None:
        die("nothing to rewrite (no commits)")
    mapping, new_objects = plan_rewrite(
        tip, args.strip_prefix, pattern, args.replacement or "")
    plan = {
        "branch": ref,
        "old_head": tip,
        "new_head": mapping[tip],
        "mapping": mapping,
    }
    write_staging(plan, new_objects)
    if args.fail_after_objects:
        print("filter: objects staged, exiting before ref update "
              "(--fail-after-objects)")
        return EXIT_FAIL_AFTER_OBJECTS
    finalize(plan)
    print(f"filter: {ref} {plan['old_head']} -> {plan['new_head']} "
          f"({len(new_objects)} new objects)")
    return 0


def cmd_log(_args):
    require_repo()
    tip = read_ref(head_ref())
    if tip is None:
        return 0
    for oid in reversed(topo_order(tip)):
        commit = parse_commit(read_object(oid)[1])
        subject = commit["message"].splitlines()[0] if commit["message"] else ""
        print(f"{oid} {subject}")
    return 0


def cmd_cat_file(args):
    require_repo()
    obj_type, data = read_object(args.oid)
    sys.stdout.write(obj_type + "\n")
    sys.stdout.flush()
    sys.stdout.buffer.write(data)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="minigit")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init").set_defaults(func=cmd_init)

    p_commit = sub.add_parser("commit")
    p_commit.add_argument("-m", "--message", required=True)
    p_commit.add_argument("--file", action="append", default=[],
                          metavar="PATH=TEXT")
    p_commit.set_defaults(func=cmd_commit)

    p_filter = sub.add_parser("filter")
    p_filter.add_argument("--strip-prefix")
    p_filter.add_argument("--message-regex")
    p_filter.add_argument("--replacement")
    p_filter.add_argument("--fail-after-objects", action="store_true")
    p_filter.add_argument("--abort", action="store_true")
    p_filter.set_defaults(func=cmd_filter)

    sub.add_parser("log").set_defaults(func=cmd_log)

    p_cat = sub.add_parser("cat-file")
    p_cat.add_argument("oid")
    p_cat.set_defaults(func=cmd_cat_file)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
