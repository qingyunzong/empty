"""Turn a matching into an executable, correctly ordered operation list.

Handles rename cycles (via temporary names that collide with no input
path), file<->directory prefix conflicts, and produces operations that
can be applied sequentially to a real tree.
"""
from __future__ import annotations

from .model import content_sha256


class PlannerError(RuntimeError):
    """Raised when no executable operation order can be derived."""


def _ancestors(path):
    parts = path.split("/")
    return ["/".join(parts[:k]) for k in range(1, len(parts))]


def plan_ops(source_files, target_files, assignments):
    """Build the ordered executable operation list for a matching.

    ``assignments`` is a list of ``(src_path | None, dst_path | None)``.
    Returns a list of operation dicts (rename/delete/create/modify).
    """
    renames = {}
    modifies = {}
    deletes = set()
    creates = {}
    for src, dst in assignments:
        if src is not None and dst is not None:
            if src != dst:
                renames[src] = dst
            if list(source_files[src]) != list(target_files[dst]):
                modifies[dst] = (list(source_files[src]), list(target_files[dst]))
        elif src is not None:
            deletes.add(src)
        else:
            creates[dst] = list(target_files[dst])

    current = set(source_files)
    location = {src: src for src in renames}
    owner_at = {src: src for src in renames}
    used_names = set(source_files) | set(target_files)
    ops = []
    temp_counter = [0]

    def fresh_temp():
        while True:
            candidate = "__filepatch_tmp_%d__" % temp_counter[0]
            temp_counter[0] += 1
            if candidate in used_names:
                continue
            if any(p.startswith(candidate + "/") for p in used_names):
                continue
            used_names.add(candidate)
            return candidate

    def emit_rename(actual, dst, lines):
        ops.append(
            {
                "op": "rename",
                "src": actual,
                "dst": dst,
                "src_sha256": content_sha256(lines),
            }
        )
        current.discard(actual)
        current.add(dst)

    def emit_delete(path):
        lines = list(source_files[path])
        ops.append(
            {
                "op": "delete",
                "path": path,
                "lines": lines,
                "src_sha256": content_sha256(lines),
            }
        )
        current.discard(path)
        deletes.discard(path)

    processed = set()
    stack = []

    def move_aside(src):
        """Move the file owned by ``src`` to a temporary name."""
        tmp = fresh_temp()
        loc = location[src]
        emit_rename(loc, tmp, source_files[src])
        location[src] = tmp
        owner_at.pop(loc, None)
        owner_at[tmp] = src

    def vacate(path):
        """Make ``path`` (currently occupied) free."""
        if path in deletes:
            emit_delete(path)
            return
        owner = owner_at.get(path)
        if owner is None:
            raise PlannerError(
                "path %r is occupied by a file that is kept, "
                "but the target tree needs it gone" % path
            )
        do_rename(owner)

    def do_rename(src):
        if src in processed:
            return
        if src in stack:
            # Rename cycle (direct or via a directory-prefix dependency):
            # move this file aside to a temporary name first.
            move_aside(src)
            return
        stack.append(src)
        dst = renames[src]
        if dst in _ancestors(src):
            # Renaming a file "up" onto its own directory (e.g. a/b -> a).
            # Route through a temporary name so that the reverse patch is
            # executable as well (a -> tmp -> a/b needs a free "a").
            move_aside(src)
        for ancestor in _ancestors(dst):
            if ancestor not in current:
                continue
            if ancestor == location[src]:
                # Renaming a file below itself (file becomes a directory):
                # move it aside first, then into its final location.
                move_aside(src)
            else:
                vacate(ancestor)
        if dst in current and dst != location[src]:
            vacate(dst)
        # Recursion above may have moved this file to a temporary name
        # (rename cycle); read its current location only now.
        loc = location[src]
        emit_rename(loc, dst, source_files[src])
        owner_at.pop(loc, None)
        processed.add(src)
        stack.pop()

    for src in sorted(renames):
        do_rename(src)
    for path in sorted(deletes):
        if path in current:
            emit_delete(path)
    for dst in sorted(creates):
        ops.append({"op": "create", "path": dst, "lines": list(creates[dst])})
        current.add(dst)
    for path in sorted(modifies):
        old_lines, new_lines = modifies[path]
        ops.append(
            {
                "op": "modify",
                "path": path,
                "lines": list(new_lines),
                "old_lines": list(old_lines),
                "src_sha256": content_sha256(old_lines),
            }
        )
    return ops


def invert_ops(ops):
    """Reverse an operation list (undoes a patch when applied in order)."""
    inverted = []
    for op in reversed(ops):
        kind = op["op"]
        if kind == "rename":
            inverted.append(
                {
                    "op": "rename",
                    "src": op["dst"],
                    "dst": op["src"],
                    "src_sha256": op["src_sha256"],
                }
            )
        elif kind == "modify":
            inverted.append(
                {
                    "op": "modify",
                    "path": op["path"],
                    "lines": list(op["old_lines"]),
                    "old_lines": list(op["lines"]),
                    "src_sha256": content_sha256(op["lines"]),
                }
            )
        elif kind == "create":
            inverted.append(
                {
                    "op": "delete",
                    "path": op["path"],
                    "lines": list(op["lines"]),
                    "src_sha256": content_sha256(op["lines"]),
                }
            )
        elif kind == "delete":
            inverted.append(
                {"op": "create", "path": op["path"], "lines": list(op["lines"])}
            )
        else:
            raise PlannerError("unknown operation: %r" % kind)
    return inverted
