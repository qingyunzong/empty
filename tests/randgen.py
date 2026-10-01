"""Random well-formed closure program generator (depth <= 3).

Generates programs that are guaranteed to compile and terminate:
  * globally unique names (no shadowing, which is a compile error),
  * variables only used in scope and with the right type,
  * division/modulo only by nonzero literals,
  * no recursion, and the language has no loops, so every program halts.
"""

import random

INT = ("int",)


def FN(arity, ret):
    return ("fn", arity, ret)


class Gen:
    def __init__(self, seed):
        self.rng = random.Random(seed)
        self.n = 0

    def fresh(self, prefix):
        self.n += 1
        return f"{prefix}{self.n}"

    # ----- program / statements ----------------------------------------

    def gen_program(self):
        scope = []  # list of (name, type), outermost first
        lines = self.gen_stmts(scope, depth=0, budget=self.rng.randint(3, 6))
        lines.append(f"return {self.gen_expr(INT, scope, 0, 3)};")
        return "\n".join(lines)

    def gen_stmts(self, scope, depth, budget):
        lines = []
        for _ in range(budget):
            choices = ["let_int", "let_int", "assign", "print", "expr"]
            if depth < 3:
                choices += ["let_fn", "let_fn"]
            if depth < 2:
                choices.append("if")
            kind = self.rng.choice(choices)
            if kind == "let_int":
                name = self.fresh("v")
                lines.append(
                    f"let {name} = {self.gen_expr(INT, scope, depth, 2)};"
                )
                scope.append((name, INT))
            elif kind == "let_fn":
                name = self.fresh("f")
                ftype, text = self.gen_fn_literal(scope, depth)
                lines.append(f"let {name} = {text};")
                scope.append((name, ftype))
            elif kind == "assign":
                targets = [n for n, t in scope if t == INT]
                if targets:
                    name = self.rng.choice(targets)
                    lines.append(
                        f"{name} = {self.gen_expr(INT, scope, depth, 2)};"
                    )
                else:
                    name = self.fresh("v")
                    lines.append(f"let {name} = {self.rng.randint(0, 20)};")
                    scope.append((name, INT))
            elif kind == "print":
                lines.append(f"print({self.gen_expr(INT, scope, depth, 1)});")
            elif kind == "if":
                cond = self.gen_cmp(scope, depth)
                then_lines = self.gen_if_branch(scope, depth)
                else_lines = self.gen_if_branch(scope, depth)
                lines.append(f"if {cond} {{")
                lines.extend("  " + line for line in then_lines)
                lines.append("} else {")
                lines.extend("  " + line for line in else_lines)
                lines.append("}")
            else:
                lines.append(f"{self.gen_expr(INT, scope, depth, 1)};")
        return lines

    def gen_if_branch(self, scope, depth):
        # No `let` inside branches: blocks do not introduce scopes, and we
        # keep the visible-name model simple.
        lines = []
        for _ in range(self.rng.randint(1, 2)):
            targets = [n for n, t in scope if t == INT]
            if targets and self.rng.random() < 0.7:
                name = self.rng.choice(targets)
                lines.append(
                    f"{name} = {self.gen_expr(INT, scope, depth, 1)};"
                )
            else:
                lines.append(
                    f"print({self.gen_expr(INT, scope, depth, 1)});"
                )
        return lines

    def gen_cmp(self, scope, depth):
        op = self.rng.choice(["<", "<=", ">", ">=", "==", "!="])
        left = self.gen_expr(INT, scope, depth, 1)
        right = self.gen_expr(INT, scope, depth, 1)
        return f"{left} {op} {right}"

    # ----- functions ----------------------------------------------------

    def gen_fn_literal(self, scope, depth):
        arity = self.rng.randint(0, 2)
        if depth <= 1 and self.rng.random() < 0.25:
            ret = FN(self.rng.randint(0, 1), INT)
        else:
            ret = INT
        params = [self.fresh("p") for _ in range(arity)]
        body_scope = list(scope) + [(p, INT) for p in params]
        body = self.gen_stmts(body_scope, depth + 1, self.rng.randint(1, 3))
        body.append(f"return {self.gen_expr(ret, body_scope, depth + 1, 2)};")
        inner = "\n".join("  " + line for line in body)
        text = f"fn({', '.join(params)}) {{\n{inner}\n}}"
        return FN(arity, ret), text

    # ----- expressions --------------------------------------------------

    def gen_expr(self, type_, scope, depth, fuel):
        if type_ != INT:
            return self.gen_fn_typed_expr(type_, scope, depth, fuel)
        int_vars = [n for n, t in scope if t == INT]
        options = ["lit"]
        if int_vars:
            options += ["var"] * 3
        if fuel > 0:
            options += ["binop", "binop"]
            callees = [
                (n, t) for n, t in scope if t[0] == "fn" and t[2] == INT
            ]
            if callees:
                options += ["call", "call"]
        kind = self.rng.choice(options)
        if kind == "lit":
            return str(self.rng.randint(0, 50))
        if kind == "var":
            return self.rng.choice(int_vars)
        if kind == "call":
            name, ftype = self.rng.choice(
                [(n, t) for n, t in scope if t[0] == "fn" and t[2] == INT]
            )
            args = ", ".join(
                self.gen_expr(INT, scope, depth, fuel - 1)
                for _ in range(ftype[1])
            )
            return f"{name}({args})"
        # binop
        op = self.rng.choice(["+", "-", "*", "/", "%"])
        left = self.gen_expr(INT, scope, depth, fuel - 1)
        if op in ("/", "%"):
            right = str(self.rng.randint(1, 9))
        else:
            right = self.gen_expr(INT, scope, depth, fuel - 1)
        return f"({left} {op} {right})"

    def gen_fn_typed_expr(self, type_, scope, depth, fuel):
        _, arity, ret = type_
        matching = [n for n, t in scope if t == type_]
        if matching and (depth >= 3 or self.rng.random() < 0.4):
            return self.rng.choice(matching)
        if depth >= 3:
            # Cannot build a literal here; fall back to any int-returning
            # function variable, else a 0-ary literal is impossible, so the
            # caller guarantees depth < 3 for fn-typed expressions.
            if matching:
                return self.rng.choice(matching)
            raise AssertionError("no fn value available at max depth")
        _, text = self.gen_fn_literal(scope, depth)
        return text
