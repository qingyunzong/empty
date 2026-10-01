"""Per-module type checker.

A module is checked against the exported interfaces of the modules it
imports, so modules can be checked independently (and incrementally) as
long as dependencies are checked first in topological order.
"""
from __future__ import annotations

from dataclasses import dataclass

from .lang import (
    INT,
    Bin,
    Call,
    Fun,
    Let,
    Module,
    Num,
    TFun,
    Var,
)

E_PARSE = "E_PARSE"
E_NAME = "E_NAME"
E_TYPE = "E_TYPE"


@dataclass
class Diag:
    line: int
    code: str
    message: str


def check_module(mod: Module, import_exports: dict) -> tuple[list[Diag], dict]:
    """Check one module.

    ``import_exports`` maps imported module name -> exported symbol table
    (name -> type), or None when the imported module does not exist.

    Returns (diagnostics, exports) where exports maps the module's own
    top-level names to their types.
    """
    diags: list[Diag] = []
    env: dict = {}  # name -> type, or None for a not-yet-checked own `let`

    for mod_name, line in mod.imports:
        exports = import_exports.get(mod_name)
        if exports is None:
            diags.append(Diag(line, E_NAME, f"unknown module '{mod_name}'"))
            continue
        for name, typ in exports.items():
            if name in env:
                diags.append(Diag(
                    line, E_NAME,
                    f"duplicate definition of '{name}' (imported from '{mod_name}')",
                ))
            else:
                env[name] = typ

    decl_map: dict = {}
    for decl in mod.decls:
        if decl.name in env or decl.name in decl_map:
            diags.append(Diag(decl.line, E_NAME, f"duplicate definition of '{decl.name}'"))
            continue
        decl_map[decl.name] = decl
        if isinstance(decl, Fun):
            env[decl.name] = TFun(tuple(t for _, t in decl.params), decl.ret)
        else:
            env[decl.name] = None  # resolved lazily

    checking: set = set()

    def resolve(name: str, line: int):
        if name not in env:
            diags.append(Diag(line, E_NAME, f"undefined name '{name}'"))
            return INT
        typ = env[name]
        if typ is not None:
            return typ
        if name in checking:
            diags.append(Diag(line, E_NAME, f"circular definition of '{name}'"))
            return INT
        decl = decl_map[name]
        checking.add(name)
        body_t = check_expr(decl.expr, {})
        checking.discard(name)
        if decl.ann is not None:
            if body_t != decl.ann:
                diags.append(Diag(
                    decl.line, E_TYPE,
                    f"let '{decl.name}' annotated as {decl.ann}, "
                    f"but initializer has type {body_t}",
                ))
            typ = decl.ann
        else:
            typ = body_t
        env[name] = typ
        return typ

    def check_expr(expr, locals_):
        if isinstance(expr, Num):
            return INT
        if isinstance(expr, Var):
            if expr.name in locals_:
                return locals_[expr.name]
            return resolve(expr.name, expr.line)
        if isinstance(expr, Bin):
            left_t = check_expr(expr.left, locals_)
            right_t = check_expr(expr.right, locals_)
            if left_t != INT or right_t != INT:
                diags.append(Diag(
                    expr.line, E_TYPE,
                    f"operator '{expr.op}' expects Int operands, "
                    f"got {left_t} and {right_t}",
                ))
            return INT
        if isinstance(expr, Call):
            func_t = check_expr(expr.func, locals_)
            arg_ts = [check_expr(a, locals_) for a in expr.args]
            if not isinstance(func_t, TFun):
                diags.append(Diag(
                    expr.line, E_TYPE,
                    f"cannot call value of type {func_t}",
                ))
                return INT
            if len(arg_ts) != len(func_t.params):
                diags.append(Diag(
                    expr.line, E_TYPE,
                    f"expected {len(func_t.params)} argument(s), got {len(arg_ts)}",
                ))
            else:
                for idx, (arg_t, param_t) in enumerate(zip(arg_ts, func_t.params), 1):
                    if arg_t != param_t:
                        diags.append(Diag(
                            expr.line, E_TYPE,
                            f"argument {idx} expects {param_t}, got {arg_t}",
                        ))
            return func_t.ret
        raise AssertionError(f"unknown expression node: {expr!r}")

    def check_fun(decl: Fun) -> None:
        locals_: dict = {}
        for pname, ptype in decl.params:
            if pname in locals_:
                diags.append(Diag(decl.line, E_NAME, f"duplicate parameter '{pname}'"))
            else:
                locals_[pname] = ptype
        body_t = check_expr(decl.body, locals_)
        if body_t != decl.ret:
            diags.append(Diag(
                decl.line, E_TYPE,
                f"function '{decl.name}' should return {decl.ret}, "
                f"but body has type {body_t}",
            ))

    for decl in mod.decls:
        if decl_map.get(decl.name) is not decl:
            continue  # duplicate definition, already reported
        if isinstance(decl, Fun):
            check_fun(decl)
        else:
            resolve(decl.name, decl.line)

    exports = {name: env[name] for name in decl_map}
    return diags, exports
