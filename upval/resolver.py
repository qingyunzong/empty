"""Scope resolution and escape analysis.

The resolver walks the parsed AST and:

* resolves every variable reference to either a local slot or an
  upvalue slot (Lox-style upvalue threading, deduplicated in first
  occurrence order);
* reports ``FreeVar`` for unbound references and ``DuplicateDef`` for
  redefinitions of a name that is already visible (shadowing is not
  allowed, even across function levels);
* performs escape analysis: a local variable is *boxed* (promoted to a
  shared heap cell) iff it is captured by a nested function whose
  closure may outlive the frame that owns the variable.  Captures by
  non-escaping inner functions keep the variable in a plain stack
  slot; those closures reference the owner frame directly.
"""

from . import parser as ast
from .errors import DuplicateDef, FreeVar


class Local:
    __slots__ = ("name", "boxed", "captured_by", "assigned_in_descendant")

    def __init__(self, name):
        self.name = name
        self.boxed = False
        self.captured_by = []            # FnInfos whose closure references this local
        self.assigned_in_descendant = False


class Upvalue:
    __slots__ = ("name", "kind", "index")

    def __init__(self, name, kind, index):
        self.name = name
        self.kind = kind    # "local" (from parent frame) | "upvalue" (threaded)
        self.index = index


class FnInfo:
    def __init__(self, fid, level, parent, node, name):
        self.id = fid
        self.level = level
        self.parent = parent
        self.node = node          # FnLit, or None for the top level
        self.name = name
        self.params = []
        self.locals = []
        self.local_map = {}
        self.upvalues = []
        self.upvalue_map = {}
        self.body = None
        self.param_count = 0
        self.escaping_children = set()  # FnInfos of fn literals escaping this fn
        self.callresult_out = False     # a call result may flow out of this fn


class Resolver:
    def __init__(self):
        self.infos = []

    def resolve(self, block):
        top = FnInfo(0, 0, None, None, "<top>")
        top.body = block
        self.infos.append(top)
        self.resolve_stmts(top, block.stmts)
        self.analyze()
        top.all_infos = self.infos
        return top

    # -- scopes ---------------------------------------------------------

    def new_fn(self, parent, node, name="<fn>"):
        info = FnInfo(len(self.infos), parent.level + 1, parent, node, name)
        node.info = info
        self.infos.append(info)
        return info

    def define(self, info, name, span):
        fn = info
        while fn is not None:
            if name in fn.local_map:
                raise DuplicateDef(
                    f"duplicate definition of '{name}'",
                    var=name, level=info.level, span=span,
                )
            fn = fn.parent
        idx = len(info.locals)
        info.locals.append(Local(name))
        info.local_map[name] = idx
        return idx

    def resolve_stmts(self, info, stmts):
        for stmt in stmts:
            self.resolve_stmt(info, stmt)

    def resolve_stmt(self, info, stmt):
        if isinstance(stmt, ast.Let):
            if isinstance(stmt.value, ast.FnLit):
                # pre-bind so the function name is visible inside its own
                # body (recursion)
                stmt.slot = self.define(info, stmt.name, stmt.name_span)
                child = self.new_fn(info, stmt.value, name=stmt.name)
                self.resolve_fn(child, stmt.value)
            else:
                self.resolve_expr(info, stmt.value)
                stmt.slot = self.define(info, stmt.name, stmt.name_span)
            return
        if isinstance(stmt, ast.Assign):
            self.resolve_expr(info, stmt.value)
            stmt.res, stmt.owner, owner_idx = self.resolve_var(info, stmt.name, stmt.name_span)
            if stmt.owner is not info:
                stmt.owner.locals[owner_idx].assigned_in_descendant = True
            return
        if isinstance(stmt, ast.ExprStmt):
            self.resolve_expr(info, stmt.expr)
            return
        raise AssertionError(f"unknown statement {stmt!r}")

    def resolve_fn(self, info, fnlit):
        for pname, pspan in fnlit.params:
            self.define(info, pname, pspan)
            info.params.append(pname)
        info.param_count = len(fnlit.params)
        info.body = fnlit.body
        self.resolve_stmts(info, fnlit.body.stmts)

    def resolve_expr(self, info, expr):
        if isinstance(expr, ast.IntLit):
            return
        if isinstance(expr, ast.Var):
            expr.res, _owner, _idx = self.resolve_var(info, expr.name, expr.span)
            return
        if isinstance(expr, ast.BinOp):
            self.resolve_expr(info, expr.left)
            self.resolve_expr(info, expr.right)
            return
        if isinstance(expr, ast.Call):
            self.resolve_expr(info, expr.callee)
            for arg in expr.args:
                self.resolve_expr(info, arg)
            return
        if isinstance(expr, ast.IfExpr):
            self.resolve_expr(info, expr.cond)
            self.resolve_stmts(info, expr.then.stmts)
            self.resolve_stmts(info, expr.otherwise.stmts)
            return
        if isinstance(expr, ast.FnLit):
            child = self.new_fn(info, expr)
            self.resolve_fn(child, expr)
            return
        raise AssertionError(f"unknown expression {expr!r}")

    # -- variables --------------------------------------------------------

    def resolve_var(self, info, name, span):
        if name in info.local_map:
            idx = info.local_map[name]
            return ("local", idx), info, idx
        up = self.resolve_upvalue(info, name)
        if up is None:
            raise FreeVar(
                f"undefined free variable '{name}'",
                var=name, level=info.level, span=span,
            )
        owner, owner_idx = self.upvalue_owner(info, up)
        return ("upvalue", up), owner, owner_idx

    def resolve_upvalue(self, info, name):
        parent = info.parent
        if parent is None:
            return None
        if name in parent.local_map:
            idx = parent.local_map[name]
            return self.add_upvalue(info, name, "local", idx, parent, idx)
        up = self.resolve_upvalue(parent, name)
        if up is None:
            return None
        owner, owner_idx = self.upvalue_owner(parent, up)
        return self.add_upvalue(info, name, "upvalue", up, owner, owner_idx)

    def add_upvalue(self, info, name, kind, index, owner, owner_idx):
        # deduplicate captures, keeping first occurrence order
        if name in info.upvalue_map:
            return info.upvalue_map[name]
        slot = len(info.upvalues)
        info.upvalues.append(Upvalue(name, kind, index))
        info.upvalue_map[name] = slot
        owner.locals[owner_idx].captured_by.append(info)
        return slot

    def upvalue_owner(self, info, up_idx):
        upvalue = info.upvalues[up_idx]
        if upvalue.kind == "local":
            return info.parent, upvalue.index
        return self.upvalue_owner(info.parent, upvalue.index)

    # -- escape analysis --------------------------------------------------

    def analyze(self):
        for info in self.infos:
            self.flow_analysis(info)
        for info in self.infos:
            for local in info.locals:
                local.boxed = any(
                    self.escapes(captor, info) for captor in local.captured_by
                )

    def flow_analysis(self, info):
        """Compute which fn literals defined directly in ``info`` may flow
        out of it (returned, passed as call arguments, or assigned to an
        outer variable), plus whether an opaque call result may flow out.
        """
        aliases = {}    # local name -> set of FnLit nodes its value may be
        tainted = set()  # locals that may hold an unknown (call result) fn
        escaping = set()  # FnLit nodes escaping this fn
        callresult_out = False

        def var_sources(name):
            lits = set(aliases.get(name, ()))
            taint = name in tainted
            idx = info.local_map.get(name)
            if idx is not None and info.locals[idx].assigned_in_descendant:
                taint = True
            return lits, taint

        def sink(lits, taint):
            nonlocal callresult_out
            escaping.update(lits)
            if taint:
                callresult_out = True

        def analyze_expr(expr):
            """Process escaping sinks inside ``expr``; return the set of fn
            literals (and taint flag) the expression's value may be."""
            if isinstance(expr, ast.IntLit):
                return set(), False
            if isinstance(expr, ast.Var):
                if expr.res[0] == "upvalue":
                    return set(), True  # unknown value from an outer scope
                return var_sources(expr.name)
            if isinstance(expr, ast.FnLit):
                return {expr}, False
            if isinstance(expr, ast.BinOp):
                analyze_expr(expr.left)
                analyze_expr(expr.right)
                return set(), False
            if isinstance(expr, ast.Call):
                analyze_expr(expr.callee)
                for arg in expr.args:
                    lits, taint = analyze_expr(arg)
                    sink(lits, taint)
                return set(), True
            if isinstance(expr, ast.IfExpr):
                analyze_expr(expr.cond)
                process(expr.then.stmts, False)
                process(expr.otherwise.stmts, False)
                lits1, taint1 = block_value(expr.then)
                lits2, taint2 = block_value(expr.otherwise)
                return lits1 | lits2, taint1 or taint2
            raise AssertionError(f"unknown expression {expr!r}")

        def block_value(block):
            if block.stmts and isinstance(block.stmts[-1], ast.ExprStmt):
                return analyze_expr(block.stmts[-1].expr)
            return set(), False

        def process(stmts, toplevel):
            for i, stmt in enumerate(stmts):
                last = i == len(stmts) - 1
                if isinstance(stmt, ast.Let):
                    lits, taint = analyze_expr(stmt.value)
                    aliases.setdefault(stmt.name, set()).update(lits)
                    if taint:
                        tainted.add(stmt.name)
                elif isinstance(stmt, ast.Assign):
                    lits, taint = analyze_expr(stmt.value)
                    if stmt.owner is info:
                        aliases.setdefault(stmt.name, set()).update(lits)
                        if taint:
                            tainted.add(stmt.name)
                    else:
                        sink(lits, taint)
                elif isinstance(stmt, ast.ExprStmt):
                    lits, taint = analyze_expr(stmt.expr)
                    if toplevel and last:
                        sink(lits, taint)

        while True:
            before = (
                sum(len(v) for v in aliases.values()),
                len(tainted),
                len(escaping),
                callresult_out,
            )
            process(info.body.stmts, True)
            after = (
                sum(len(v) for v in aliases.values()),
                len(tainted),
                len(escaping),
                callresult_out,
            )
            if before == after:
                break

        info.escaping_children = {lit.info for lit in escaping}
        info.callresult_out = callresult_out

    def escapes(self, fn, owner):
        """May the closure of ``fn`` outlive the frame of ``owner``?
        (``owner`` is an ancestor of ``fn``.)"""
        parent = fn.parent
        if parent is owner:
            return fn in owner.escaping_children
        if fn in parent.escaping_children and owner.callresult_out:
            # fn's value leaks out of its parent (e.g. as the parent's
            # return value) and an opaque call result may flow out of
            # ``owner``, so conservatively fn escapes ``owner`` too.
            return True
        # otherwise fn's closure is confined to its parent's frame, which
        # itself outlives ``owner`` only if the parent escapes it
        return self.escapes(parent, owner)


def debug_dict(top):
    """Structured view of the analysis result (used by --debug and tests)."""
    functions = []
    for info in top.all_infos:
        functions.append({
            "id": info.id,
            "name": info.name,
            "level": info.level,
            "params": list(info.params),
            "locals": [
                {"name": local.name, "slot": idx, "boxed": local.boxed}
                for idx, local in enumerate(info.locals)
            ],
            "upvalues": [
                {"name": up.name, "from": up.kind, "index": up.index}
                for up in info.upvalues
            ],
        })
    return {"functions": functions}
