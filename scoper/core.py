"""Scope resolution for a small block-structured language.

Input is a parsed AST as JSON-compatible data with six node types:
block, let, const, fn, use, assign.

Semantics:
  * Global names and function parameters are bound when their scope is
    entered.
  * let/const names are hoisted into their block at block entry but stay
    in the temporal dead zone (TDZ) until their declaration statement is
    reached.
  * fn names are resolvable from the start of their block, but the body
    is processed lazily when the fn statement is reached in order.
  * use resolves to the nearest visible binding, falling back to a
    builtin; assign additionally requires a writable (non-const) binding.
"""

from __future__ import annotations

BUILTINS = frozenset({
    "print", "len", "range", "str", "int", "float", "bool", "list",
    "dict", "set", "tuple", "type", "input", "abs", "min", "max",
    "sum", "enumerate", "zip", "map", "filter", "sorted", "reversed",
})

ERR_UNDEFINED = "Undefined"
ERR_DUPLICATE = "Duplicate"
ERR_TDZ = "TDZ"
ERR_ASSIGN_CONST = "AssignConst"


class ScopeError(Exception):
    """A scope resolution failure."""

    def __init__(self, name, kind, use_span=None, def_span=None):
        self.name = name
        self.kind = kind
        self.use_span = use_span
        self.def_span = def_span
        super().__init__("%s: %s" % (kind, name))

    def to_dict(self):
        return {
            "name": self.name,
            "kind": self.kind,
            "use_span": self.use_span,
            "def_span": self.def_span,
        }


class _Def:
    __slots__ = ("id", "name", "kind", "span", "initialized")

    def __init__(self, id_, name, kind, span, initialized):
        self.id = id_
        self.name = name
        self.kind = kind  # "let" | "const" | "fn" | "param"
        self.span = span
        self.initialized = initialized


class _Scope:
    __slots__ = ("kind", "parent", "defs", "fn_def_id", "captures")

    def __init__(self, kind, parent):
        self.kind = kind  # "global" | "block" | "fn"
        self.parent = parent
        self.defs = {}
        self.fn_def_id = None
        self.captures = set()


class _Resolver:
    def __init__(self):
        self.defs = []
        self.uses = []
        self.assigns = []
        self.fn_scopes = []

    def run(self, node):
        if isinstance(node, list):
            node = {"type": "block", "stmts": node}
        if not isinstance(node, dict) or node.get("type") != "block":
            raise ValueError("top-level AST node must be a block")
        self._block(node, _Scope("global", None))
        return self._output()

    def _new_def(self, scope, name, kind, span, initialized):
        d = _Def(len(self.defs), name, kind, span, initialized)
        self.defs.append(d)
        scope.defs[name] = d
        return d

    def _block(self, node, scope):
        stmts = node.get("stmts", [])
        # Hoist let/const/fn names declared directly in this block.
        for st in stmts:
            t = st.get("type")
            if t in ("let", "const", "fn"):
                name = st["name"]
                if name in scope.defs:
                    raise ScopeError(name, ERR_DUPLICATE,
                                     st.get("span"), scope.defs[name].span)
                self._new_def(scope, name, t, st.get("span"),
                              initialized=(t == "fn"))
        # Execute statements in order.
        for st in stmts:
            t = st.get("type")
            if t in ("let", "const"):
                scope.defs[st["name"]].initialized = True
            elif t == "fn":
                self._fn(st, scope)
            elif t == "use":
                self._use(st, scope)
            elif t == "assign":
                self._assign(st, scope)
            elif t == "block":
                self._block(st, _Scope("block", scope))
            else:
                raise ValueError("unknown node type: %r" % (t,))

    def _fn(self, node, scope):
        fn_def = scope.defs[node["name"]]
        fn_scope = _Scope("fn", scope)
        fn_scope.fn_def_id = fn_def.id
        self.fn_scopes.append(fn_scope)
        for param in node.get("params", []):
            if param in fn_scope.defs:
                raise ScopeError(param, ERR_DUPLICATE,
                                 node.get("span"), fn_scope.defs[param].span)
            self._new_def(fn_scope, param, "param", node.get("span"), True)
        body = node.get("body") or {"type": "block", "stmts": []}
        self._block(body, _Scope("block", fn_scope))

    def _lookup(self, scope, name):
        crossed_fns = []
        s = scope
        while s is not None:
            d = s.defs.get(name)
            if d is not None:
                return d, crossed_fns
            if s.kind == "fn":
                crossed_fns.append(s)
            s = s.parent
        return None, crossed_fns

    def _bind(self, node, scope, record):
        name = node["name"]
        span = node.get("span")
        d, crossed_fns = self._lookup(scope, name)
        if d is None:
            if name in BUILTINS:
                record.append({"name": name, "span": span, "builtin": True})
                return None
            raise ScopeError(name, ERR_UNDEFINED, span, None)
        if d.kind in ("let", "const") and not d.initialized:
            raise ScopeError(name, ERR_TDZ, span, d.span)
        for fn_scope in crossed_fns:
            fn_scope.captures.add(d.id)
        return d

    def _use(self, node, scope):
        d = self._bind(node, scope, self.uses)
        if d is not None:
            self.uses.append(
                {"name": node["name"], "span": node.get("span"),
                 "def_id": d.id})

    def _assign(self, node, scope):
        d = self._bind(node, scope, self.assigns)
        if d is None:
            # Assigning to a builtin is treated as assigning an undefined
            # name: there is no writable user binding.
            raise ScopeError(node["name"], ERR_UNDEFINED,
                             node.get("span"), None)
        if d.kind == "const":
            raise ScopeError(node["name"], ERR_ASSIGN_CONST,
                             node.get("span"), d.span)
        self.assigns.append(
            {"name": node["name"], "span": node.get("span"),
             "def_id": d.id})

    def _output(self):
        return {
            "defs": [{"id": d.id, "name": d.name, "kind": d.kind,
                      "span": d.span} for d in self.defs],
            "uses": self.uses,
            "assigns": self.assigns,
            "captures": {str(fs.fn_def_id): sorted(fs.captures)
                         for fs in self.fn_scopes},
        }


def resolve(ast):
    """Resolve all names in *ast*.

    Returns a dict with keys "defs", "uses", "assigns", "captures".
    Raises ScopeError on Undefined / Duplicate / TDZ / AssignConst.
    """
    return _Resolver().run(ast)
