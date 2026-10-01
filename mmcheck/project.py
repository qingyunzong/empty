"""Project-level orchestration: dependency graph, deterministic full and
incremental checking, and persistent state.

State is stored as JSON in ``.mmcheck.json`` in the current working
directory.  Each diagnostic carries a stable id; diagnostics belonging to
modules that are not re-checked by a ``patch`` keep their ids.
"""
from __future__ import annotations

import hashlib
import heapq
import json
import os
from dataclasses import dataclass, field

from .checker import E_PARSE, Diag, check_module
from .lang import ParseError, TFun, TInt, parse

STATE_FILE = ".mmcheck.json"
MODULE_EXT = ".mm"


class CycleError(Exception):
    def __init__(self, cycle: list[str]):
        super().__init__("import cycle: " + " -> ".join(cycle))
        self.cycle = cycle


class ProjectError(Exception):
    """Usage/state errors (exit code 2)."""


# ---------------------------------------------------------------------------
# Types <-> JSON
# ---------------------------------------------------------------------------

def type_to_json(typ) -> dict:
    if isinstance(typ, TInt):
        return {"kind": "int"}
    return {
        "kind": "fun",
        "params": [type_to_json(p) for p in typ.params],
        "ret": type_to_json(typ.ret),
    }


def type_from_json(data: dict):
    if data["kind"] == "int":
        return TInt()
    return TFun(
        tuple(type_from_json(p) for p in data["params"]),
        type_from_json(data["ret"]),
    )


# ---------------------------------------------------------------------------
# State model
# ---------------------------------------------------------------------------

@dataclass
class StoredDiag:
    id: int
    line: int
    code: str
    message: str


@dataclass
class ModuleState:
    name: str
    file: str  # path relative to project dir
    content_hash: str
    imports: list
    exports: dict  # name -> type
    diagnostics: list  # list[StoredDiag]


@dataclass
class ProjectState:
    directory: str
    next_id: int
    modules: dict  # name -> ModuleState

    def all_diagnostics(self) -> list:
        """Every diagnostic, sorted by (file, line, code, message)."""
        out = []
        for name, mod in self.modules.items():
            for d in mod.diagnostics:
                out.append((mod.file, d.line, d.code, d.message, d.id))
        out.sort(key=lambda t: (t[0], t[1], t[2], t[3]))
        return [
            {"id": d[4], "file": d[0], "line": d[1], "code": d[2], "message": d[3]}
            for d in out
        ]


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def save_state(state: ProjectState, cwd: str) -> None:
    data = {
        "version": 1,
        "dir": state.directory,
        "next_id": state.next_id,
        "modules": {
            name: {
                "file": m.file,
                "content_hash": m.content_hash,
                "imports": m.imports,
                "exports": {n: type_to_json(t) for n, t in m.exports.items()},
                "diagnostics": [
                    {"id": d.id, "line": d.line, "code": d.code, "message": d.message}
                    for d in m.diagnostics
                ],
            }
            for name, m in sorted(state.modules.items())
        },
    }
    path = os.path.join(cwd, STATE_FILE)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")


def load_state(cwd: str) -> ProjectState:
    path = os.path.join(cwd, STATE_FILE)
    if not os.path.exists(path):
        raise ProjectError("no project loaded (run 'load <dir>' first)")
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    modules = {}
    for name, m in data["modules"].items():
        modules[name] = ModuleState(
            name=name,
            file=m["file"],
            content_hash=m["content_hash"],
            imports=list(m["imports"]),
            exports={n: type_from_json(t) for n, t in m["exports"].items()},
            diagnostics=[
                StoredDiag(d["id"], d["line"], d["code"], d["message"])
                for d in m["diagnostics"]
            ],
        )
    return ProjectState(data["dir"], data["next_id"], modules)


# ---------------------------------------------------------------------------
# Dependency graph helpers
# ---------------------------------------------------------------------------

def discover_modules(directory: str) -> dict:
    """Map module name -> absolute path for every ``*.mm`` file in dir."""
    if not os.path.isdir(directory):
        raise ProjectError(f"not a directory: {directory}")
    out = {}
    for entry in sorted(os.listdir(directory)):
        if entry.endswith(MODULE_EXT) and os.path.isfile(os.path.join(directory, entry)):
            name = entry[: -len(MODULE_EXT)]
            out[name] = os.path.join(directory, entry)
    return out


def find_cycle(graph: dict) -> list | None:
    """Return one import cycle as [a, b, ..., a], or None. Deterministic."""
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {n: WHITE for n in graph}
    stack: list = []

    def dfs(node):
        color[node] = GRAY
        stack.append(node)
        for dep in sorted(graph[node]):
            if color[dep] == GRAY:
                idx = stack.index(dep)
                return stack[idx:] + [dep]
            if color[dep] == WHITE:
                found = dfs(dep)
                if found:
                    return found
        stack.pop()
        color[node] = BLACK
        return None

    for node in sorted(graph):
        if color[node] == WHITE:
            found = dfs(node)
            if found:
                return found
    return None


def topo_order(graph: dict) -> list:
    """Dependencies first; deterministic (ties broken by module name)."""
    dependents = {n: [] for n in graph}
    indegree = {n: 0 for n in graph}
    for node, deps in graph.items():
        for dep in deps:
            dependents[dep].append(node)
            indegree[node] += 1
    ready = [n for n, deg in indegree.items() if deg == 0]
    heapq.heapify(ready)
    order = []
    while ready:
        node = heapq.heappop(ready)
        order.append(node)
        for dependent in dependents[node]:
            indegree[dependent] -= 1
            if indegree[dependent] == 0:
                heapq.heappush(ready, dependent)
    if len(order) != len(graph):
        raise CycleError(find_cycle(graph) or ["?"])
    return order


def transitive_dependents(graph: dict, name: str) -> set:
    """All modules that directly or transitively import ``name``."""
    dependents = {n: [] for n in graph}
    for node, deps in graph.items():
        for dep in deps:
            dependents[dep].append(node)
    seen = set()
    stack = list(dependents.get(name, []))
    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        stack.extend(dependents[node])
    return seen


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def _parse_source(src: str):
    """Return (ast, parse_diag); exactly one of the two is not None."""
    try:
        return parse(src), None
    except ParseError as exc:
        return None, Diag(exc.line, E_PARSE, exc.message)


def _read_module_file(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read()


# ---------------------------------------------------------------------------
# Full check (used by `load` and `check`)
# ---------------------------------------------------------------------------

def full_check(directory: str) -> ProjectState:
    """Parse and check every module in ``directory``.

    Raises CycleError (atomic: no state is written by the caller) if the
    import graph has a cycle.  Diagnostic ids are assigned 1..n in sorted
    (file, line, code) order, so a full check is fully deterministic.
    """
    directory = os.path.abspath(directory)
    files = discover_modules(directory)

    parsed = {}  # name -> (hash, ast, parse_diag)
    for name, path in files.items():
        src = _read_module_file(path)
        ast, parse_diag = _parse_source(src)
        parsed[name] = (_hash(src), ast, parse_diag)

    graph = {name: [] for name in files}
    for name, (_, ast, _) in parsed.items():
        if ast is not None:
            graph[name] = sorted({m for m, _ in ast.imports if m in files})

    cycle = find_cycle(graph)
    if cycle:
        raise CycleError(cycle)

    order = topo_order(graph)
    exports: dict = {}
    raw_diags: dict = {}
    for name in order:
        _, ast, parse_diag = parsed[name]
        if ast is None:
            raw_diags[name] = [parse_diag]
            exports[name] = {}
        else:
            import_exports = {m: exports.get(m) for m, _ in ast.imports}
            diags, exp = check_module(ast, import_exports)
            raw_diags[name] = diags
            exports[name] = exp

    # Assign ids in globally sorted (file, line, code) order.
    flat = []
    for name in order:
        for d in raw_diags[name]:
            flat.append((name, d))
    flat.sort(key=lambda nd: (f"{nd[0]}{MODULE_EXT}", nd[1].line, nd[1].code, nd[1].message))

    assigned: dict = {name: [] for name in order}
    next_id = 1
    for name, d in flat:
        assigned[name].append(StoredDiag(next_id, d.line, d.code, d.message))
        next_id += 1

    modules = {}
    for name in order:
        content_hash, ast, _ = parsed[name]
        imports = sorted({m for m, _ in ast.imports}) if ast is not None else []
        modules[name] = ModuleState(
            name=name,
            file=os.path.relpath(files[name], directory),
            content_hash=content_hash,
            imports=imports,
            exports=exports[name],
            diagnostics=assigned[name],
        )
    return ProjectState(directory, next_id, modules)


# ---------------------------------------------------------------------------
# Incremental patch
# ---------------------------------------------------------------------------

def patch_module(state: ProjectState, file_path: str):
    """Re-check after ``file_path`` changed on disk.

    Returns the set of re-checked module names, or None when the patch is
    a no-op (content identical to the loaded state).  Only the patched
    module and its transitive dependents (in the old and the new import
    graph) are re-checked; every other module's diagnostics and ids are
    left untouched.  Raises CycleError without mutating state if the new
    imports introduce a cycle.
    """
    abs_path = os.path.abspath(file_path)
    if os.path.dirname(abs_path) != state.directory or not abs_path.endswith(MODULE_EXT):
        raise ProjectError(
            f"file {file_path} is not a {MODULE_EXT} module in {state.directory}"
        )
    if not os.path.isfile(abs_path):
        raise ProjectError(f"file not found: {file_path}")
    name = os.path.basename(abs_path)[: -len(MODULE_EXT)]

    src = _read_module_file(abs_path)
    content_hash = _hash(src)
    old = state.modules.get(name)
    if old is not None and old.content_hash == content_hash:
        return None  # no-op

    ast, parse_diag = _parse_source(src)

    # New graph: stored imports for untouched modules, fresh imports for the
    # patched one.  Edges only point at modules that exist.
    nodes = set(state.modules) | {name}
    new_graph = {}
    for node in nodes:
        if node == name:
            imps = [m for m, _ in ast.imports] if ast is not None else []
        else:
            imps = state.modules[node].imports
        new_graph[node] = sorted({m for m in imps if m in nodes})

    cycle = find_cycle(new_graph)
    if cycle:
        raise CycleError(cycle)  # atomic: state untouched

    old_graph = {
        n: [m for m in mod.imports if m in state.modules]
        for n, mod in state.modules.items()
    }
    affected = (
        {name}
        | transitive_dependents(new_graph, name)
        | transitive_dependents(old_graph, name)
    )

    order = [n for n in topo_order(new_graph) if n in affected]
    exports_map = {n: mod.exports for n, mod in state.modules.items()}

    for node in order:
        if node == name:
            node_src, node_ast, node_diag, node_hash = src, ast, parse_diag, content_hash
            rel = os.path.relpath(abs_path, state.directory)
        else:
            mod_state = state.modules[node]
            path = os.path.join(state.directory, mod_state.file)
            node_src = _read_module_file(path)
            node_hash = _hash(node_src)
            node_ast, node_diag = _parse_source(node_src)
            rel = mod_state.file

        if node_ast is None:
            diags = [node_diag]
            node_exports = {}
            imports = []
        else:
            import_exports = {m: exports_map.get(m) for m, _ in node_ast.imports}
            diags, node_exports = check_module(node_ast, import_exports)
            imports = sorted({m for m, _ in node_ast.imports})
        exports_map[node] = node_exports

        diags_sorted = sorted(diags, key=lambda d: (d.line, d.code, d.message))
        stored = []
        for d in diags_sorted:
            stored.append(StoredDiag(state.next_id, d.line, d.code, d.message))
            state.next_id += 1

        state.modules[node] = ModuleState(
            name=node,
            file=rel,
            content_hash=node_hash,
            imports=imports,
            exports=node_exports,
            diagnostics=stored,
        )

    return affected
