"""Per-module type checking. A module is checked against the exported
environments of the modules it imports, nothing else."""
from __future__ import annotations

from dataclasses import dataclass

from .lang import (
    parse_module, INT, BOOL, UNKNOWN, FN, type_str,
    Import, Let, Fn, IntLit, BoolLit, Var, Add, Call,
)

E_PARSE = "E_PARSE"
E_NAME = "E_NAME"
E_TYPE = "E_TYPE"


@dataclass
class Diagnostic:
    line: int
    code: str
    message: str


@dataclass
class CheckResult:
    diagnostics: list
    exports: dict


def _is_fn(t):
    return isinstance(t, tuple) and len(t) == 3 and t[0] == "fn"


def check_module(name, source, dep_exports):
    """Check one module. dep_exports maps imported module name -> {name: type}.
    Returns CheckResult; exports are always deterministic, even with errors."""
    stmts, _imports, err = parse_module(source)
    if err is not None:
        return CheckResult([Diagnostic(err.line, E_PARSE, err.message)], {})

    diags = []
    globals_ = {}
    imported = {}
    exports = {}

    def lookup(nm, line, locals_):
        if locals_ is not None and nm in locals_:
            return locals_[nm]
        if nm in globals_:
            return globals_[nm]
        if nm in imported:
            return imported[nm]
        diags.append(Diagnostic(line, E_NAME, "undefined name '%s'" % nm))
        return UNKNOWN

    def check_expr(e, locals_):
        if isinstance(e, IntLit):
            return INT
        if isinstance(e, BoolLit):
            return BOOL
        if isinstance(e, Var):
            return lookup(e.name, e.line, locals_)
        if isinstance(e, Add):
            lt = check_expr(e.left, locals_)
            rt = check_expr(e.right, locals_)
            if lt == UNKNOWN or rt == UNKNOWN:
                return UNKNOWN
            if lt == INT and rt == INT:
                return INT
            diags.append(Diagnostic(e.line, E_TYPE,
                                    "cannot add %s and %s" % (type_str(lt), type_str(rt))))
            return UNKNOWN
        if isinstance(e, Call):
            ft = lookup(e.name, e.line, locals_)
            argtypes = [check_expr(a, locals_) for a in e.args]
            if ft == UNKNOWN:
                return UNKNOWN
            if not _is_fn(ft):
                diags.append(Diagnostic(e.line, E_TYPE, "'%s' is not a function" % e.name))
                return UNKNOWN
            params, ret = ft[1], ft[2]
            if len(argtypes) != len(params):
                diags.append(Diagnostic(
                    e.line, E_TYPE,
                    "'%s' expects %d argument(s), got %d" % (e.name, len(params), len(argtypes))))
                return UNKNOWN
            for i, (at, pt) in enumerate(zip(argtypes, params)):
                if at != UNKNOWN and at != pt:
                    diags.append(Diagnostic(
                        e.args[i].line, E_TYPE,
                        "argument %d of '%s' expects %s, got %s"
                        % (i + 1, e.name, type_str(pt), type_str(at))))
            return ret
        raise AssertionError("unknown expr %r" % (e,))

    for stmt in stmts:
        if isinstance(stmt, Import):
            if stmt.name not in dep_exports:
                diags.append(Diagnostic(stmt.line, E_NAME,
                                        "unknown module '%s'" % stmt.name))
            else:
                imported.update(dep_exports[stmt.name])
        elif isinstance(stmt, Let):
            t = check_expr(stmt.expr, None)
            if stmt.annotation is not None and t != UNKNOWN and t != stmt.annotation:
                diags.append(Diagnostic(
                    stmt.line, E_TYPE,
                    "'%s' annotated as %s but initializer has type %s"
                    % (stmt.name, type_str(stmt.annotation), type_str(t))))
            final = stmt.annotation if stmt.annotation is not None else t
            if stmt.name in globals_:
                diags.append(Diagnostic(stmt.line, E_NAME,
                                        "duplicate definition of '%s'" % stmt.name))
            globals_[stmt.name] = final
            exports[stmt.name] = final
        elif isinstance(stmt, Fn):
            fnt = FN([pt for _, pt in stmt.params], stmt.ret)
            if stmt.name in globals_:
                diags.append(Diagnostic(stmt.line, E_NAME,
                                        "duplicate definition of '%s'" % stmt.name))
            globals_[stmt.name] = fnt
            exports[stmt.name] = fnt
            locals_ = {}
            for pn, pt in stmt.params:
                if pn in locals_:
                    diags.append(Diagnostic(stmt.line, E_NAME,
                                            "duplicate parameter '%s'" % pn))
                locals_[pn] = pt
            bt = check_expr(stmt.body, locals_)
            if bt != UNKNOWN and bt != stmt.ret:
                diags.append(Diagnostic(
                    stmt.line, E_TYPE,
                    "function '%s' body has type %s but declared return type is %s"
                    % (stmt.name, type_str(bt), type_str(stmt.ret))))
    return CheckResult(diags, exports)
