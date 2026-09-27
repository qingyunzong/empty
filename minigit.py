#!/usr/bin/env python3
"""minigit: a tiny content-addressed VCS (Python 3.11 stdlib only).

Commands:
  init                          create an empty repository (.minigit/)
  commit -m MSG -f path=text    commit multiple path texts with a message
  filter [--strip-prefix P] [--message-regex RE --replacement X]
                                rewrite all reachable commits in topo order
    --fail-after-objects        fault injection: stop after objects are
                                written to the staging area, before the ref
                                update (original ref stays untouched)
  abort                         discard the staging area; history unchanged

Filter semantics:
  * commits are rewritten in topological order, parent references are
    remapped to the new commit ids;
  * every path starting with --strip-prefix is dropped from each tree,
    all other paths are kept verbatim; the message gets exactly one
    regex substitution (count=1);
  * if a commit's tree and message are both unchanged (and its parents
    were not rewritten), the original commit id is reused and no new
    object is produced;
  * all new objects are written into a staging area first; the branch
    ref is updated atomically (tmp file + rename) at the very end;
  * re-running `filter` while a staging area exists resumes from it and
    completes the rewrite; `abort` wipes the staging area instead.

Exit codes: 0 ok, 1 generic error, 2 invalid regex, 3 fail-after-objects.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import zlib

REPO_DIR = ".minigit"
STAGING_DIR = "staging"
BRANCH = "main"

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_BAD_REGEX = 2
EXIT_FAIL_AFTER_OBJECTS = 3


class RepoError(Exception):
    pass


def repo_path(root, *parts):
    return os.path.join(root, REPO_DIR, *parts)


# ---------------------------------------------------------------- objects

def hash_object(type_, data):
    header = f"{type_} {len(data)}\0".encode()
    return hashlib.sha1(header + data).hexdigest()


def object_path(objdir, oid):
    return os.path.join(objdir, oid[:2], oid[2:])


def write_object(objdir, type_, data):
    """Write an object if missing; return its id (content-addressed)."""
    oid = hash_object(type_, data)
    path = object_path(objdir, oid)
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        payload = f"{type_} {len(data)}\0".encode() + data
        with open(tmp, "wb") as fh:
            fh.write(zlib.compress(payload))
        os.replace(tmp, path)
    return oid


def read_object(objdir, oid):
    with open(object_path(objdir, oid), "rb") as fh:
        raw = zlib.decompress(fh.read())
    header, _, data = raw.partition(b"\0")
    type_ = header.split(b" ", 1)[0].decode()
    return type_, data


# ---------------------------------------------------------------- trees

def encode_tree(entries):
    out = b""
    for mode, name, oid in sorted(entries, key=lambda e: e[1]):
        out += f"{mode} {name}".encode() + b"\0" + bytes.fromhex(oid)
    return out


def decode_tree(data):
    entries = []
    i = 0
    while i < len(data):
        sp = data.index(b" ", i)
        mode = data[i:sp].decode()
        nul = data.index(b"\0", sp)
        name = data[sp + 1:nul].decode()
        oid = data[nul + 1:nul + 21].hex()
        entries.append((mode, name, oid))
        i = nul + 21
    return entries


def build_tree(objdir, paths):
    """Write tree objects for a flat {path: blob_oid} map; return root id."""
    nested = {}
    for path, oid in sorted(paths.items()):
        parts = path.split("/")
        node = nested
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = oid

    def emit(node):
        entries = []
        for name, value in sorted(node.items()):
            if isinstance(value, dict):
                entries.append(("40000", name, emit(value)))
            else:
                entries.append(("100644", name, value))
        return write_object(objdir, "tree", encode_tree(entries))

    return emit(nested)


def flatten_tree(objdir, tree_oid, prefix=""):
    """Return {path: blob_oid} for every file under tree_oid."""
    result = {}
    _, data = read_object(objdir, tree_oid)
    for mode, name, oid in decode_tree(data):
        path = prefix + name
        if mode == "40000":
            result.update(flatten_tree(objdir, oid, path + "/"))
        else:
            result[path] = oid
    return result


# ---------------------------------------------------------------- commits

def encode_commit(tree, parents, message):
    lines = [f"tree {tree}"]
    lines += [f"parent {p}" for p in parents]
    return ("\n".join(lines) + "\n\n" + message).encode()


def decode_commit(data):
    header, _, message = data.partition(b"\n\n")
    tree = None
    parents = []
    for line in header.decode().splitlines():
        if line.startswith("tree "):
            tree = line[5:]
        elif line.startswith("parent "):
            parents.append(line[7:])
    return tree, parents, message.decode()


def topo_order(objdir, head):
    """Parents-before-children order of every commit reachable from head."""
    order = []
    seen = set()

    def visit(oid):
        if oid in seen:
            return
        seen.add(oid)
        _, parents, _ = decode_commit(read_object(objdir, oid)[1])
        for parent in parents:
            visit(parent)
        order.append(oid)

    visit(head)
    return order


# ---------------------------------------------------------------- refs

def read_ref(root, name=BRANCH):
    path = repo_path(root, "refs", "heads", name)
    if not os.path.exists(path):
        return None
    with open(path) as fh:
        return fh.read().strip()


def write_ref(root, name, oid):
    """Atomic ref update: write temp file, then rename."""
    path = repo_path(root, "refs", "heads", name)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        fh.write(oid + "\n")
    os.replace(tmp, path)


# ---------------------------------------------------------------- commands

def cmd_init(root):
    os.makedirs(repo_path(root, "objects"), exist_ok=True)
    os.makedirs(repo_path(root, "refs", "heads"), exist_ok=True)
    print(f"Initialized empty repository in {repo_path(root)}")
    return EXIT_OK


def cmd_commit(root, files, message):
    objdir = repo_path(root, "objects")
    if not os.path.isdir(objdir):
        raise RepoError("not a repository (run `init` first)")
    head = read_ref(root)
    paths = {}
    parents = []
    if head:
        tree, _, _ = decode_commit(read_object(objdir, head)[1])
        paths = flatten_tree(objdir, tree)
        parents = [head]
    for spec in files:
        if "=" not in spec:
            raise RepoError(f"bad --file spec (want path=text): {spec!r}")
        path, text = spec.split("=", 1)
        paths[path] = write_object(objdir, "blob", text.encode())
    tree_oid = build_tree(objdir, paths)
    commit_oid = write_object(
        objdir, "commit", encode_commit(tree_oid, parents, message))
    write_ref(root, BRANCH, commit_oid)
    print(commit_oid)
    return EXIT_OK


def staging_dir(root):
    return repo_path(root, STAGING_DIR)


def finalize_staging(root):
    """Move staged objects into the store, atomically update the branch."""
    staging = staging_dir(root)
    with open(os.path.join(staging, "state.json")) as fh:
        state = json.load(fh)
    objdir = repo_path(root, "objects")
    staged_objdir = os.path.join(staging, "objects")
    for dirpath, _, filenames in os.walk(staged_objdir):
        for filename in filenames:
            src = os.path.join(dirpath, filename)
            dst = os.path.join(objdir, os.path.relpath(src, staged_objdir))
            if not os.path.exists(dst):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                os.replace(src, dst)
    write_ref(root, BRANCH, state["new_head"])
    shutil.rmtree(staging)
    print(state["new_head"])
    return EXIT_OK


def cmd_filter(root, strip_prefix, message_regex, replacement,
               fail_after_objects):
    try:
        pattern = re.compile(message_regex) if message_regex is not None else None
    except re.error as exc:
        print(f"error: invalid regex {message_regex!r}: {exc}", file=sys.stderr)
        return EXIT_BAD_REGEX

    staging = staging_dir(root)
    if os.path.exists(os.path.join(staging, "state.json")):
        # Resume an interrupted rewrite from the staging area.
        return finalize_staging(root)

    objdir = repo_path(root, "objects")
    head = read_ref(root)
    if head is None:
        print("error: no commits to filter", file=sys.stderr)
        return EXIT_ERROR

    staged_objdir = os.path.join(staging, "objects")
    os.makedirs(staged_objdir, exist_ok=True)

    mapping = {}
    for oid in topo_order(objdir, head):
        tree, parents, message = decode_commit(read_object(objdir, oid)[1])
        new_parents = [mapping.get(p, p) for p in parents]
        paths = flatten_tree(objdir, tree)
        if strip_prefix:
            new_paths = {p: b for p, b in paths.items()
                         if not p.startswith(strip_prefix)}
        else:
            new_paths = paths
        new_message = (pattern.sub(replacement, message, count=1)
                       if pattern else message)
        if (new_parents == parents and new_paths == paths
                and new_message == message):
            # Unchanged: reuse the original commit id, write nothing.
            mapping[oid] = oid
            continue
        new_tree = build_tree(staged_objdir, new_paths)
        new_oid = write_object(
            staged_objdir, "commit",
            encode_commit(new_tree, new_parents, new_message))
        mapping[oid] = new_oid

    new_head = mapping[head]
    with open(os.path.join(staging, "state.json"), "w") as fh:
        json.dump({"head": head, "new_head": new_head, "mapping": mapping}, fh)

    if fail_after_objects:
        print("fail-after-objects: objects staged, ref left unchanged",
              file=sys.stderr)
        return EXIT_FAIL_AFTER_OBJECTS
    return finalize_staging(root)


def cmd_abort(root):
    shutil.rmtree(staging_dir(root), ignore_errors=True)
    print("staging area discarded; history unchanged")
    return EXIT_OK


def main(argv=None):
    parser = argparse.ArgumentParser(prog="minigit")
    parser.add_argument("-C", "--repo", default=".",
                        help="repository root (default: cwd)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="create an empty repository")

    p_commit = sub.add_parser("commit", help="commit path texts + message")
    p_commit.add_argument("-m", "--message", default="")
    p_commit.add_argument("-f", "--file", action="append", default=[],
                          metavar="PATH=TEXT", help="set file content")

    p_filter = sub.add_parser("filter", help="rewrite reachable history")
    p_filter.add_argument("--strip-prefix", default=None)
    p_filter.add_argument("--message-regex", default=None)
    p_filter.add_argument("--replacement", default="")
    p_filter.add_argument("--fail-after-objects", action="store_true")

    sub.add_parser("abort", help="discard the staging area")

    args = parser.parse_args(argv)
    try:
        if args.command == "init":
            return cmd_init(args.repo)
        if args.command == "commit":
            return cmd_commit(args.repo, args.file, args.message)
        if args.command == "filter":
            return cmd_filter(args.repo, args.strip_prefix,
                              args.message_regex, args.replacement,
                              args.fail_after_objects)
        if args.command == "abort":
            return cmd_abort(args.repo)
    except RepoError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
