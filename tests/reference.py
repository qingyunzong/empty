"""Independent environment-stack reference implementation.

Deliberately structured differently from ``scoper.resolver`` (recursive
closures over an explicit list-of-dicts environment, cell objects as
plain dicts) while implementing the same semantics:

* builtins + params bound on scope entry;
* let/const hoisted into their block in TDZ, activated at their statement;
* fn names hoisted active, bodies resolved at the definition point;
* use -> nearest visible binding; assign to const -> AssignConst;
* captures = outer def_ids referenced from a fn body, transitively.
"""

from scoper.errors import (
    AssignConstError,
    ScopeError,
    KIND_DUPLICATE,
    KIND_TDZ,
    KIND_UNDEFINED,
)
from scoper.resolver import BUILTINS


def reference_resolve(tree):
    defs = []
    uses = []
    assigns = []
    functions = []
    def_depths = []
    env = []       # stack of dict: name -> cell
    fn_stack = []  # stack of {"depth": int, "captures": set}

    def declare(scope, name, kind, span, active):
        if name in scope:
            raise ScopeError(KIND_DUPLICATE, name, span, scope[name]["span"])
        cell = {
            "id": len(defs),
            "kind": kind,
            "span": span,
            "active": active,
            "depth": len(env) - 1,
        }
        scope[name] = cell
        defs.append({"def_id": cell["id"], "name": name,
                     "kind": kind, "span": span})
        def_depths.append(cell["depth"])
        return cell

    def lookup(name, span):
        for scope in reversed(env):
            cell = scope.get(name)
            if cell is not None:
                if not cell["active"]:
                    raise ScopeError(KIND_TDZ, name, span, cell["span"])
                return cell
        if name in BUILTINS:
            return None
        raise ScopeError(KIND_UNDEFINED, name, span, None)

    def capture(cell):
        for frame in fn_stack:
            if cell["depth"] < frame["depth"]:
                frame["captures"].add(cell["id"])

    def do_use(node):
        cell = lookup(node["name"], node.get("span"))
        if cell is None:
            uses.append({"name": node["name"],
                         "span": node.get("span"), "builtin": True})
        else:
            uses.append({"name": node["name"],
                         "span": node.get("span"), "def_id": cell["id"]})
            capture(cell)

    def do_expr(node):
        ntype = node.get("type")
        if ntype == "use":
            do_use(node)
        elif ntype == "lit":
            pass
        else:
            raise ValueError("unknown expression type: %r" % (ntype,))

    def do_block(node):
        scope = {}
        env.append(scope)
        try:
            stmts = node.get("stmts", [])
            for stmt in stmts:  # hoisting pass
                stype = stmt.get("type")
                if stype in ("let", "const"):
                    declare(scope, stmt["name"], stype,
                            stmt.get("span"), False)
                elif stype == "fn":
                    declare(scope, stmt["name"], "fn",
                            stmt.get("span"), True)
            for stmt in stmts:  # execution pass
                do_stmt(stmt, scope)
        finally:
            env.pop()

    def do_fn(node, scope):
        frame = {"depth": len(env), "captures": set()}
        env.append({})
        fn_stack.append(frame)
        try:
            for param in node.get("params", []):
                declare(env[-1], param["name"], "param",
                        param.get("span"), True)
            do_block(node["body"])
        finally:
            fn_stack.pop()
            env.pop()
        captures = sorted(frame["captures"])
        functions.append({"name": node["name"],
                          "def_id": scope[node["name"]]["id"],
                          "captures": captures})
        if fn_stack:
            parent = fn_stack[-1]
            for def_id in captures:
                if def_depths[def_id] < parent["depth"]:
                    parent["captures"].add(def_id)

    def do_stmt(stmt, scope):
        stype = stmt.get("type")
        if stype in ("let", "const"):
            if stmt.get("init") is not None:
                do_expr(stmt["init"])
            scope[stmt["name"]]["active"] = True
        elif stype == "fn":
            do_fn(stmt, scope)
        elif stype == "use":
            do_use(stmt)
        elif stype == "assign":
            cell = lookup(stmt["name"], stmt.get("span"))
            if cell is None:
                raise AssignConstError(stmt["name"], stmt.get("span"), None)
            if cell["kind"] == "const":
                raise AssignConstError(stmt["name"], stmt.get("span"),
                                       cell["span"])
            if stmt.get("value") is not None:
                do_expr(stmt["value"])
            assigns.append({"name": stmt["name"],
                            "span": stmt.get("span"),
                            "def_id": cell["id"]})
            capture(cell)
        elif stype == "block":
            do_block(stmt)
        else:
            raise ValueError("unknown statement type: %r" % (stype,))

    do_block(tree)
    return {"defs": defs, "uses": uses,
            "assigns": assigns, "functions": functions}
