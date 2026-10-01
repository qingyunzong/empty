"""Project state, dependency graph, and the load/check/patch operations."""
from __future__ import annotations

import hashlib
import heapq
import json
import os
import sys

from .checker import check_module
from .lang import parse_module, thaw

MODULE_EXT = ".mt"
STATE_FILE = ".mtc_state.json"


class CycleError(Exception):
    def __init__(self, cycle):
        super().__init__("import cycle: " + " -> ".join(cycle))
        self.cycle = cycle


# --- Dependency graph -----------------------------------------------------

def _deps(graph, m):
    return [d for d in graph[m] if d in graph]


def find_cycle(graph):
    """Deterministic DFS (sorted order). Returns the cycle as a list of
    module names ending where it started, or None."""
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {m: WHITE for m in graph}
    for start in sorted(graph):
        if color[start] != WHITE:
            continue
        color[start] = GRAY
        path = [start]
        stack = [(start, iter(sorted(_deps(graph, start))))]
        while stack:
            node, it = stack[-1]
            descended = False
            for nb in it:
                if color[nb] == GRAY:
                    idx = path.index(nb)
                    return path[idx:] + [nb]
                if color[nb] == WHITE:
                    color[nb] = GRAY
                    path.append(nb)
                    stack.append((nb, iter(sorted(_deps(graph, nb)))))
                    descended = True
                    break
            if not descended:
                color[node] = BLACK
                stack.pop()
                path.pop()
    return None


def topo_order(graph):
    """Dependencies before dependents, deterministic (Kahn + min-heap)."""
    indeg = {m: 0 for m in graph}
    dependents = {}
    for m in graph:
        for d in _deps(graph, m):
            indeg[m] += 1
            dependents.setdefault(d, []).append(m)
    ready = [m for m in graph if indeg[m] == 0]
    heapq.heapify(ready)
    order = []
    while ready:
        m = heapq.heappop(ready)
        order.append(m)
        for dep in dependents.get(m, []):
            indeg[dep] -= 1
            if indeg[dep] == 0:
                heapq.heappush(ready, dep)
    return order


def transitive_dependents(graph, name):
    """name plus every module that directly or transitively imports it."""
    rev = {}
    for m in graph:
        for d in _deps(graph, m):
            rev.setdefault(d, []).append(m)
    affected = set()
    stack = [name]
    while stack:
        m = stack.pop()
        if m in affected:
            continue
        affected.add(m)
        stack.extend(rev.get(m, []))
    return affected


# --- Module records -------------------------------------------------------

def _record(name, source, imports, result):
    return {
        "path": name + MODULE_EXT,
        "sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        "source": source,
        "imports": list(imports),
        "exports": result.exports,
        "diagnostics": [vars(d) for d in result.diagnostics],
    }


def _imports_of(source):
    _stmts, imports, _err = parse_module(source)
    return list(imports)


def check_all(directory):
    """Full recheck of every *.mt file in directory. Returns the modules
    mapping (JSON-friendly). Raises CycleError."""
    names = sorted(
        fn[: -len(MODULE_EXT)]
        for fn in os.listdir(directory)
        if fn.endswith(MODULE_EXT)
        and os.path.isfile(os.path.join(directory, fn))
    )
    sources = {}
    graph = {}
    for name in names:
        with open(os.path.join(directory, name + MODULE_EXT), encoding="utf-8") as fh:
            sources[name] = fh.read()
        graph[name] = _imports_of(sources[name])
    cycle = find_cycle(graph)
    if cycle:
        raise CycleError(cycle)
    modules = {}
    exports_by = {}
    for name in topo_order(graph):
        dep_exports = {d: exports_by[d] for d in graph[name] if d in exports_by}
        result = check_module(name, sources[name], dep_exports)
        exports_by[name] = result.exports
        modules[name] = _record(name, sources[name], graph[name], result)
    return modules


def format_all(modules):
    """All diagnostics as 'file:line:code: message', sorted by file/line/code."""
    entries = []
    for rec in modules.values():
        for d in rec["diagnostics"]:
            entries.append((rec["path"], d["line"], d["code"], d["message"]))
    entries.sort()
    return ["%s:%d:%s: %s" % e for e in entries]


# --- State ----------------------------------------------------------------

def _state_path():
    return os.path.join(os.getcwd(), STATE_FILE)


def save_state(directory, modules):
    state = {"dir": os.path.abspath(directory), "modules": modules}
    with open(_state_path(), "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)


def load_state():
    if not os.path.isfile(_state_path()):
        return None
    with open(_state_path(), encoding="utf-8") as fh:
        state = json.load(fh)
    for rec in state["modules"].values():
        rec["exports"] = {k: thaw(v) for k, v in rec["exports"].items()}
    return state


# --- Commands ---------------------------------------------------------------

def _emit(modules):
    lines = format_all(modules)
    for line in lines:
        print(line)
    return 1 if lines else 0


def do_load(directory):
    if not os.path.isdir(directory):
        print("error: not a directory: %s" % directory, file=sys.stderr)
        return 2
    try:
        modules = check_all(directory)
    except CycleError as e:
        print("error: import cycle detected: %s" % " -> ".join(e.cycle), file=sys.stderr)
        return 3
    save_state(directory, modules)
    return _emit(modules)


def do_check():
    state = load_state()
    if state is None:
        print("error: no project loaded (run 'load <dir>' first)", file=sys.stderr)
        return 2
    directory = state["dir"]
    try:
        modules = check_all(directory)
    except CycleError as e:
        print("error: import cycle detected: %s" % " -> ".join(e.cycle), file=sys.stderr)
        return 3
    save_state(directory, modules)
    return _emit(modules)


def do_patch(file_path):
    state = load_state()
    if state is None:
        print("error: no project loaded (run 'load <dir>' first)", file=sys.stderr)
        return 2
    directory = state["dir"]
    absfile = os.path.abspath(file_path)
    if os.path.dirname(absfile) != directory or not absfile.endswith(MODULE_EXT):
        print("error: %s is not a %s module of the loaded project"
              % (file_path, MODULE_EXT), file=sys.stderr)
        return 2
    if not os.path.isfile(absfile):
        print("error: file not found: %s" % file_path, file=sys.stderr)
        return 2
    name = os.path.basename(absfile)[: -len(MODULE_EXT)]
    with open(absfile, encoding="utf-8") as fh:
        source = fh.read()
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()

    modules = state["modules"]
    if name in modules and modules[name]["sha256"] == digest:
        print("no-op")
        return 0

    graph = {m: list(rec["imports"]) for m, rec in modules.items()}
    graph[name] = _imports_of(source)
    cycle = find_cycle(graph)
    if cycle:
        print("error: import cycle detected: %s" % " -> ".join(cycle), file=sys.stderr)
        return 3

    affected = transitive_dependents(graph, name)
    order = [m for m in topo_order(graph) if m in affected]
    exports_by = {m: rec["exports"] for m, rec in modules.items()}
    for m in order:
        src = source if m == name else modules[m]["source"]
        dep_exports = {d: exports_by[d] for d in graph[m] if d in exports_by}
        result = check_module(m, src, dep_exports)
        exports_by[m] = result.exports
        modules[m] = _record(m, src, graph[m], result)

    save_state(directory, modules)
    return _emit(modules)
