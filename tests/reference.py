"""Independent reference parser (plain recursive descent, one function per
precedence level) used to cross-check the Pratt parser. It embodies the
"brute-force parenthesized precedence" structure: each grammar level is one
implicit pair of parentheses.

It reuses only the prattx lexer; the parse algorithm is deliberately
different from Pratt's so the two implementations cross-validate.
"""

from prattx.lexer import lex


class RefParseError(Exception):
    pass


class RefParser:
    def __init__(self, src):
        self.tokens = lex(src)
        self.pos = 0

    def peek(self):
        return self.tokens[self.pos]

    def at_op(self, *texts):
        tok = self.peek()
        return tok.kind == "op" and tok.text in texts

    def advance(self):
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def expect(self, text):
        if not self.at_op(text):
            raise RefParseError("expected %r, got %r" % (text, self.peek().text))
        return self.advance()

    # entry point: must consume all tokens
    def parse(self):
        node = self.assign()
        if self.peek().kind != "eof":
            raise RefParseError("trailing tokens")
        return node

    # assign := ternary ('=' assign)?          (right associative, lowest)
    def assign(self):
        left = self.ternary()
        if self.at_op("="):
            self.advance()
            right = self.assign()
            return self._binary("=", left, right)
        return left

    # ternary := or_expr ('?' assign ':' ternary)?   (right associative)
    def ternary(self):
        cond = self.or_expr()
        if self.at_op("?"):
            self.advance()
            then = self.assign()
            self.expect(":")
            otherwise = self.ternary()
            return {
                "op": "?:",
                "cond": cond,
                "then": then,
                "else": otherwise,
                "span": [cond["span"][0], otherwise["span"][1]],
            }
        return cond

    def _level(self, sub, ops):
        left = sub()
        while self.at_op(*ops):
            op = self.advance()
            right = sub()
            left = self._binary(op.text, left, right)
        return left

    def or_expr(self):
        return self._level(self.and_expr, ("||",))

    def and_expr(self):
        return self._level(self.cmp_expr, ("&&",))

    def cmp_expr(self):
        return self._level(self.add_expr, ("==", "!=", "<", "<=", ">", ">="))

    def add_expr(self):
        return self._level(self.mul_expr, ("+", "-"))

    def mul_expr(self):
        return self._level(self.unary_expr, ("*", "/", "%"))

    # unary := ('+'|'-'|'!') unary | power
    def unary_expr(self):
        if self.at_op("+", "-", "!"):
            op = self.advance()
            operand = self.unary_expr()
            return {
                "op": "unary" + op.text,
                "operand": operand,
                "span": [op.start, operand["span"][1]],
            }
        return self.power_expr()

    # power := postfix ('**' unary)?           (right associative, > unary)
    def power_expr(self):
        base = self.postfix_expr()
        if self.at_op("**"):
            self.advance()
            exp = self.unary_expr()
            return self._binary("**", base, exp)
        return base

    # postfix := primary ( '(' args ')' | '[' assign ']' )*
    def postfix_expr(self):
        node = self.primary()
        while True:
            if self.at_op("("):
                self.advance()
                args = []
                if not self.at_op(")"):
                    args.append(self.assign())
                    while self.at_op(","):
                        self.advance()
                        args.append(self.assign())
                close = self.expect(")")
                node = {
                    "op": "call",
                    "func": node,
                    "args": args,
                    "span": [node["span"][0], close.end],
                }
            elif self.at_op("["):
                self.advance()
                index = self.assign()
                close = self.expect("]")
                node = {
                    "op": "[]",
                    "obj": node,
                    "index": index,
                    "span": [node["span"][0], close.end],
                }
            else:
                return node

    # primary := INT | IDENT | '(' assign ')'
    def primary(self):
        tok = self.advance()
        if tok.kind == "int":
            return {"op": "int", "value": int(tok.text), "span": [tok.start, tok.end]}
        if tok.kind == "ident":
            return {"op": "ident", "name": tok.text, "span": [tok.start, tok.end]}
        if tok.kind == "op" and tok.text == "(":
            node = self.assign()
            self.expect(")")
            return node
        raise RefParseError("unexpected %r" % tok.text)

    @staticmethod
    def _binary(op, left, right):
        return {
            "op": op,
            "left": left,
            "right": right,
            "span": [left["span"][0], right["span"][1]],
        }


def parse_reference(src):
    """Parse with the reference grammar; raises RefParseError if invalid."""
    return RefParser(src).parse()
