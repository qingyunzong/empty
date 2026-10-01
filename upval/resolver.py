"""Scope resolution, escape analysis and capture computation.

Resolution annotates the AST:
  * Var/Assign nodes get ``binding`` and ``depth`` (number of function
    levels between use site and definition site).
  * FnLit nodes get ``fn_info`` and ``param_bindings``.

Escape analysis decides, for every local binding, whether it is boxed
into a shared cell (``binding.boxed``) or kept as a plain stack slot:
a binding is boxed iff it is referenced from the subtree of some
function literal that escapes its defining scope.
"""

from . import parser as ast
from .errors import CompileError, DuplicateDefError, FreeVarError


class Binding:
    __slots__ = (
        "name",
        "kind",
        "level",
        "span",
        "scope",
        "initializer",
        "boxed",
        "captured",
    )

    def __init__(self, name, kind, level, span, scope, initializer=None):
        self.name = name
        self.kind = kind  # 'let' | 'param' | 'builtin'
        self.level = level
        self.span = span
        self.scope = scope
        self.initializer = initializer
        self.boxed = False
        self.captured = False


class Scope:
    __slots__ = ("level", "kind", "parent", "node", "bindings")

    def __init__(self, level, kind, parent, node=None):
        self.level = level
        self.kind = kind  # 'top' | 'fn'
        self.parent = parent
        self.node = node
        self.bindings = {}

    def is_proper_ancestor_of(self, scope):
        """True if self is a strict ancestor scope of ``scope``."""
        cur = scope.parent
        while cur is not None:
            if cur is self:
                return True
            cur = cur.parent
        return False


class CaptureInfo:
    __slots__ = ("binding", "depth", "span")

    def __init__(self, binding, depth, span):
        self.binding = binding
        self.depth = depth
        self.span = span


class FnInfo:
    __slots__ = ("id", "node", "scope", "captures", "subtree_free", "escapes")

    def __init__(self, fid, node, scope):
        self.id = fid
        self.node = node  # FnLit, or None for the top level
        self.scope = scope
        self.captures = []  # ordered CaptureInfo, direct captures, deduped
        self.subtree_free = []  # bindings referenced from the whole subtree
        self.escapes = False

    @property
    def level(self):
        return self.scope.level


class Analysis:
    """Result of resolution + escape analysis; drives the evaluator."""

    def __init__(self, program, fn_infos, top_scope):
        self.program = program
        self.fn_infos = fn_infos
        self.top_scope = top_scope

    def to_dict(self):
        functions = []
        for info in self.fn_infos:
            scope = info.scope
            if info.node is None:
                span = list(self.program.span)
                params = []
                kind = "top"
            else:
                span = list(info.node.span)
                params = [name for name, _ in info.node.params]
                kind = "fn"
            locals_ = [
                {
                    "var": b.name,
                    "kind": b.kind,
                    "boxed": b.boxed,
                    "captured": b.captured,
                    "span": list(b.span),
                }
                for b in scope.bindings.values()
                if b.kind != "builtin"
            ]
            captures = [
                {
                    "var": c.binding.name,
                    "level": c.binding.level,
                    "depth": c.depth,
                    "boxed": c.binding.boxed,
                    "span": list(c.span),
                }
                for c in info.captures
            ]
            functions.append(
                {
                    "id": info.id,
                    "kind": kind,
                    "level": info.level,
                    "span": span,
                    "params": params,
                    "locals": locals_,
                    "captures": captures,
                    "escapes": info.escapes,
                }
            )
        return {"functions": functions}


class Resolver:
    def __init__(self):
        self.fn_infos = []
        self.program = None
        self.top_scope = None

    def resolve(self, program):
        self.program = program
        top = Scope(0, "top", None, program)
        self.top_scope = top
        print_span = (0, 0)
        top.bindings["print"] = Binding("print", "builtin", 0, print_span, top)
        top_info = FnInfo(0, None, top)
        self.fn_infos.append(top_info)
        self._resolve_block(program.body, top)
        self._compute_captures()
        self._escape_analysis()
        return Analysis(program, self.fn_infos, top)

    # ----- scope resolution ---------------------------------------------

    def _lookup(self, scope, name):
        cur = scope
        while cur is not None:
            if name in cur.bindings:
                return cur.bindings[name]
            cur = cur.parent
        return None

    def _define(self, scope, name, kind, span, initializer=None):
        if self._lookup(scope, name) is not None:
            raise DuplicateDefError(
                var=name,
                level=scope.level,
                span=span,
                message=f"duplicate definition of '{name}'",
            )
        binding = Binding(name, kind, scope.level, span, scope, initializer)
        scope.bindings[name] = binding
        return binding

    def _resolve_block(self, stmts, scope):
        for stmt in stmts:
            self._resolve_stmt(stmt, scope)

    def _resolve_stmt(self, stmt, scope):
        if isinstance(stmt, ast.Let):
            # Define first so a recursive function name is visible inside
            # its own initializer.
            stmt.binding = self._define(
                scope, stmt.name, "let", stmt.name_span, initializer=stmt.value
            )
            self._resolve_expr(stmt.value, scope)
        elif isinstance(stmt, ast.Assign):
            binding = self._lookup(scope, stmt.name)
            if binding is None:
                raise FreeVarError(
                    var=stmt.name,
                    level=scope.level,
                    span=stmt.name_span,
                    message=f"assignment to undefined variable '{stmt.name}'",
                )
            if binding.kind == "builtin":
                raise CompileError(
                    var=stmt.name,
                    level=scope.level,
                    span=stmt.name_span,
                    message=f"cannot assign to builtin '{stmt.name}'",
                )
            stmt.binding = binding
            stmt.depth = scope.level - binding.level
            self._resolve_expr(stmt.value, scope)
        elif isinstance(stmt, ast.Return):
            self._resolve_expr(stmt.value, scope)
        elif isinstance(stmt, ast.If):
            self._resolve_expr(stmt.cond, scope)
            self._resolve_block(stmt.then, scope)
            self._resolve_block(stmt.otherwise, scope)
        elif isinstance(stmt, ast.ExprStmt):
            self._resolve_expr(stmt.expr, scope)
        else:  # pragma: no cover - defensive
            raise AssertionError(f"unknown stmt {stmt!r}")

    def _resolve_expr(self, expr, scope):
        if isinstance(expr, ast.IntLit):
            return
        if isinstance(expr, ast.Var):
            binding = self._lookup(scope, expr.name)
            if binding is None:
                raise FreeVarError(
                    var=expr.name,
                    level=scope.level,
                    span=expr.span,
                    message=f"undefined variable '{expr.name}'",
                )
            expr.binding = binding
            expr.depth = scope.level - binding.level
            return
        if isinstance(expr, ast.UnaryOp):
            self._resolve_expr(expr.operand, scope)
            return
        if isinstance(expr, ast.BinOp):
            self._resolve_expr(expr.left, scope)
            self._resolve_expr(expr.right, scope)
            return
        if isinstance(expr, ast.Call):
            self._resolve_expr(expr.func, scope)
            for arg in expr.args:
                self._resolve_expr(arg, scope)
            return
        if isinstance(expr, ast.FnLit):
            child = Scope(scope.level + 1, "fn", scope, expr)
            info = FnInfo(len(self.fn_infos), expr, child)
            self.fn_infos.append(info)
            expr.fn_info = info
            for pname, pspan in expr.params:
                expr.param_bindings.append(
                    self._define(child, pname, "param", pspan)
                )
            self._resolve_block(expr.body, child)
            return
        raise AssertionError(f"unknown expr {expr!r}")  # pragma: no cover

    # ----- capture computation ------------------------------------------

    def _walk_refs(self, stmts, descend_fns, on_ref):
        """Call ``on_ref`` for every Var/Assign node, in source order."""

        def walk_expr(expr):
            if isinstance(expr, ast.Var):
                on_ref(expr)
            elif isinstance(expr, ast.UnaryOp):
                walk_expr(expr.operand)
            elif isinstance(expr, ast.BinOp):
                walk_expr(expr.left)
                walk_expr(expr.right)
            elif isinstance(expr, ast.Call):
                walk_expr(expr.func)
                for arg in expr.args:
                    walk_expr(arg)
            elif isinstance(expr, ast.FnLit):
                if descend_fns:
                    walk_stmts(expr.body)

        def walk_stmts(body):
            for stmt in body:
                if isinstance(stmt, ast.Let):
                    walk_expr(stmt.value)
                elif isinstance(stmt, ast.Assign):
                    on_ref(stmt)
                    walk_expr(stmt.value)
                elif isinstance(stmt, ast.Return):
                    walk_expr(stmt.value)
                elif isinstance(stmt, ast.ExprStmt):
                    walk_expr(stmt.expr)
                elif isinstance(stmt, ast.If):
                    walk_expr(stmt.cond)
                    walk_stmts(stmt.then)
                    walk_stmts(stmt.otherwise)

        walk_stmts(stmts)

    def _compute_captures(self):
        for info in self.fn_infos:
            body = self.program.body if info.node is None else info.node.body
            seen_direct = {}
            seen_subtree = {}

            def make_handler(table):
                def handle(node):
                    binding = node.binding
                    if binding.kind == "builtin":
                        return
                    if binding.scope is info.scope:
                        return
                    if not binding.scope.is_proper_ancestor_of(info.scope):
                        return
                    if id(binding) not in table:
                        table[id(binding)] = (binding, node.depth, node.span)

                return handle

            self._walk_refs(body, False, make_handler(seen_direct))
            self._walk_refs(body, True, make_handler(seen_subtree))
            info.captures = [
                CaptureInfo(b, d, s) for b, d, s in seen_direct.values()
            ]
            info.subtree_free = [b for b, _, _ in seen_subtree.values()]

    # ----- escape analysis ----------------------------------------------

    def _escape_analysis(self):
        esc_fn = set()  # ids of escaping FnInfo
        esc_bind = set()  # ids of bindings whose value escapes

        def mark(expr):
            if isinstance(expr, ast.FnLit):
                esc_fn.add(expr.fn_info.id)
            elif isinstance(expr, ast.Var):
                esc_bind.add(id(expr.binding))

        def walk_expr(expr):
            if isinstance(expr, ast.Call):
                walk_expr(expr.func)
                for arg in expr.args:
                    mark(arg)  # passed to an unknown function: escapes
                    walk_expr(arg)
            elif isinstance(expr, ast.UnaryOp):
                walk_expr(expr.operand)
            elif isinstance(expr, ast.BinOp):
                walk_expr(expr.left)
                walk_expr(expr.right)
            elif isinstance(expr, ast.FnLit):
                walk_stmts(expr.body)

        def walk_stmts(body):
            for stmt in body:
                if isinstance(stmt, ast.Let):
                    walk_expr(stmt.value)
                elif isinstance(stmt, ast.Assign):
                    mark(stmt.value)  # stored into an unknown place: escapes
                    walk_expr(stmt.value)
                elif isinstance(stmt, ast.Return):
                    mark(stmt.value)  # returned: escapes the function
                    walk_expr(stmt.value)
                elif isinstance(stmt, ast.ExprStmt):
                    walk_expr(stmt.expr)
                elif isinstance(stmt, ast.If):
                    walk_expr(stmt.cond)
                    walk_stmts(stmt.then)
                    walk_stmts(stmt.otherwise)

        walk_stmts(self.program.body)
        # The program's own result value escapes the top level.
        if self.program.body:
            last = self.program.body[-1]
            if isinstance(last, ast.ExprStmt):
                mark(last.expr)

        # Fixpoint: values flowing through escaping bindings/functions.
        changed = True
        while changed:
            changed = False
            for info in self.fn_infos:
                for binding in info.scope.bindings.values():
                    if id(binding) not in esc_bind:
                        continue
                    init = binding.initializer
                    if isinstance(init, ast.FnLit):
                        if init.fn_info.id not in esc_fn:
                            esc_fn.add(init.fn_info.id)
                            changed = True
                    elif isinstance(init, ast.Var):
                        if id(init.binding) not in esc_bind:
                            esc_bind.add(id(init.binding))
                            changed = True
            for info in self.fn_infos:
                if info.id in esc_fn:
                    for binding in info.subtree_free:
                        if id(binding) not in esc_bind:
                            esc_bind.add(id(binding))
                            changed = True

        # Box every binding captured by an escaping function subtree.
        for info in self.fn_infos:
            if info.id in esc_fn:
                info.escapes = True
                for binding in info.subtree_free:
                    binding.boxed = True
        for info in self.fn_infos:
            for binding in info.subtree_free:
                binding.captured = True


def resolve(program):
    return Resolver().resolve(program)
