"""Single-pass environment-stack resolver.

The resolver walks the AST with an explicit scope stack.  On block entry
all ``let``/``const``/``fn`` names of that block are hoisted into the new
scope: ``fn`` bindings are active immediately, ``let``/``const`` bindings
start in the TDZ and are activated when their statement is executed.
Function bodies are resolved when their ``fn`` statement is reached, so
they observe exactly the bindings visible at the definition point.
"""

from .errors import (
    AssignConstError,
    ScopeError,
    KIND_DUPLICATE,
    KIND_TDZ,
    KIND_UNDEFINED,
)

BUILTINS = ("print", "len", "range", "str", "int", "abs", "min", "max")



class _Binding:
    __slots__ = ("def_id", "name", "kind", "span", "active", "depth")

    def __init__(self, def_id, name, kind, span, active, depth):
        self.def_id = def_id
        self.name = name
        self.kind = kind
        self.span = span
        self.active = active
        self.depth = depth


class _FnFrame:
    __slots__ = ("depth", "captures")

    def __init__(self, depth):
        self.depth = depth
        self.captures = set()


class Resolver:
    def __init__(self):
        self.defs = []
        self.uses = []
        self.assigns = []
        self.functions = []
        self._scopes = []
        self._fn_stack = []
        self._def_depths = []

    # -- public API -----------------------------------------------------

    def resolve(self, tree):
        if not isinstance(tree, dict) or tree.get("type") != "block":
            raise ValueError("program root must be a block node")
        self._block(tree)
        return {
            "defs": self.defs,
            "uses": self.uses,
            "assigns": self.assigns,
            "functions": self.functions,
        }

    # -- scope / binding helpers ---------------------------------------

    def _declare(self, scope, name, kind, span, active):
        existing = scope.get(name)
        if existing is not None:
            raise ScopeError(KIND_DUPLICATE, name, span, existing.span)
        def_id = len(self.defs)
        binding = _Binding(def_id, name, kind, span, active, len(self._scopes) - 1)
        scope[name] = binding
        self.defs.append({
            "def_id": def_id,
            "name": name,
            "kind": kind,
            "span": span,
        })
        self._def_depths.append(binding.depth)
        return binding

    def _lookup(self, name, span):
        for scope in reversed(self._scopes):
            binding = scope.get(name)
            if binding is not None:
                if not binding.active:
                    raise ScopeError(KIND_TDZ, name, span, binding.span)
                return binding
        if name in BUILTINS:
            return None
        raise ScopeError(KIND_UNDEFINED, name, span, None)

    def _note_capture(self, binding):
        for frame in self._fn_stack:
            if binding.depth < frame.depth:
                frame.captures.add(binding.def_id)

    # -- statements -----------------------------------------------------

    def _block(self, node):
        scope = {}
        self._scopes.append(scope)
        try:
            stmts = node.get("stmts", [])
            for stmt in stmts:
                stype = stmt.get("type")
                if stype in ("let", "const"):
                    self._declare(scope, stmt["name"], stype,
                                  stmt.get("span"), active=False)
                elif stype == "fn":
                    self._declare(scope, stmt["name"], "fn",
                                  stmt.get("span"), active=True)
            for stmt in stmts:
                self._stmt(stmt, scope)
        finally:
            self._scopes.pop()

    def _stmt(self, stmt, scope):
        stype = stmt.get("type")
        if stype in ("let", "const"):
            init = stmt.get("init")
            if init is not None:
                self._expr(init)
            scope[stmt["name"]].active = True
        elif stype == "fn":
            self._fn(stmt, scope)
        elif stype == "use":
            self._use(stmt)
        elif stype == "assign":
            self._assign(stmt)
        elif stype == "block":
            self._block(stmt)
        else:
            raise ValueError("unknown statement type: %r" % (stype,))

    def _use(self, node):
        name = node["name"]
        span = node.get("span")
        binding = self._lookup(name, span)
        if binding is None:
            self.uses.append({"name": name, "span": span, "builtin": True})
        else:
            self.uses.append({
                "name": name,
                "span": span,
                "def_id": binding.def_id,
            })
            self._note_capture(binding)

    def _assign(self, node):
        name = node["name"]
        span = node.get("span")
        binding = self._lookup(name, span)
        if binding is None:
            raise AssignConstError(name, span, None)
        if binding.kind == "const":
            raise AssignConstError(name, span, binding.span)
        value = node.get("value")
        if value is not None:
            self._expr(value)
        self.assigns.append({
            "name": name,
            "span": span,
            "def_id": binding.def_id,
        })
        self._note_capture(binding)

    def _fn(self, node, scope):
        name = node["name"]
        fn_binding = scope[name]
        frame = _FnFrame(depth=len(self._scopes))
        param_scope = {}
        self._scopes.append(param_scope)
        self._fn_stack.append(frame)
        try:
            for param in node.get("params", []):
                self._declare(param_scope, param["name"], "param",
                              param.get("span"), active=True)
            self._block(node["body"])
        finally:
            self._fn_stack.pop()
            self._scopes.pop()
        captures = sorted(frame.captures)
        self.functions.append({
            "name": name,
            "def_id": fn_binding.def_id,
            "captures": captures,
        })
        if self._fn_stack:
            parent = self._fn_stack[-1]
            for def_id in captures:
                if self._def_depths[def_id] < parent.depth:
                    parent.captures.add(def_id)

    # -- expressions ----------------------------------------------------

    def _expr(self, node):
        ntype = node.get("type")
        if ntype == "use":
            self._use(node)
        elif ntype == "lit":
            return
        else:
            raise ValueError("unknown expression type: %r" % (ntype,))


def resolve_program(tree):
    """Resolve *tree* (a parsed AST dict) and return the resolution record.

    Raises :class:`scoper.errors.ScopeError` on any scope failure.
    """
    return Resolver().resolve(tree)
