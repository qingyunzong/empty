"""Shared helpers for the tinyvm test suite."""

from tinyvm.asm import assemble
from tinyvm.loader import dump_program
from tinyvm.vm import div_trunc, mod_trunc


def eval_expr(expr):
    """Evaluate an expression tree with the VM's truncating semantics."""
    if expr[0] == "const":
        return expr[1]
    op, left, right = expr
    a = eval_expr(left)
    b = eval_expr(right)
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        if b == 0:
            raise ZeroDivisionError
        return div_trunc(a, b)
    if op == "%":
        if b == 0:
            raise ZeroDivisionError
        return mod_trunc(a, b)
    raise AssertionError(f"unknown op {op!r}")


def make_expr_program(*consts_and_code):
    """Build a container directly from consts list and asm items."""
    consts, items = consts_and_code
    return dump_program(consts, assemble(items))


def factorial_program(n):
    """Program computing fact(n) by recursion; frame i handles n-i+1.

    main:  push n; CALL fact; HALT
    fact:  STORE 0          ; n = arg (from shared stack)
           LOAD 0; JZ base
           LOAD 0; CONST 1; SUB; CALL fact   ; fact(n-1)
           LOAD 0; MUL                        ; n * fact(n-1)
           RET
    base:  CONST 1; RET
    """
    consts = [n, 1, 0]
    items = [
        ("CONST", 0),
        ("CALL", "fact"),
        ("HALT",),
        "fact",
        ("STORE", 0),
        ("LOAD", 0),
        ("JZ", "base"),
        ("LOAD", 0),
        ("CONST", 1),
        ("SUB",),
        ("CALL", "fact"),
        ("LOAD", 0),
        ("MUL",),
        ("RET",),
        "base",
        ("CONST", 1),
        ("RET",),
    ]
    return dump_program(consts, assemble(items))
