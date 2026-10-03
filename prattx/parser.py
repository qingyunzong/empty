"""Pratt (top-down operator precedence) parser.

Binding-power table (higher binds tighter):

    =            5   right associative (rbp 4), lowest
    ?:          10   right associative (else-branch rbp 9)
    ||          20   left
    &&          30   left
    == != < <= > >=  40  left
    + -         50   left
    * / %       60   left
    **          70   right associative (rbp 69)
    unary + - !      operand parsed with rbp 69, so ** binds tighter
    call/subscript 90 postfix

The parser never inserts implicit grouping nodes: explicit parentheses
only steer parsing and do not appear in the AST.
"""

from .errors import ParseError
from .lexer import lex

# op text -> (lbp, rbp used to parse the right operand)
_INFIX = {
    "=": (5, 4),
    "||": (20, 20),
    "&&": (30, 30),
    "==": (40, 40), "!=": (40, 40),
    "<": (40, 40), "<=": (40, 40), ">": (40, 40), ">=": (40, 40),
    "+": (50, 50), "-": (50, 50),
    "*": (60, 60), "/": (60, 60), "%": (60, 60),
    "**": (70, 69),
}
_TERNARY_LBP = 10
_TERNARY_RBP = 9
_UNARY_RBP = 69
_POSTFIX_LBP = 90
_PREFIX_OPS = {"+": "unary+", "-": "unary-", "!": "unary!"}


def _lbp(token):
    if token.kind != "op":
        return 0
    text = token.text
    if text in _INFIX:
        return _INFIX[text][0]
    if text == "?":
        return _TERNARY_LBP
    if text in ("(", "["):
        return _POSTFIX_LBP
    return 0


class Parser:
    def __init__(self, src):
        self.src = src
        self.tokens = lex(src)
        self.pos = 0

    def peek(self):
        return self.tokens[self.pos]

    def advance(self):
        token = self.tokens[self.pos]
        self.pos += 1
        return token

    def expect(self, text):
        token = self.advance()
        if token.kind != "op" or token.text != text:
            raise ParseError(got=token.text, expected=text, span=token.span)
        return token

    def parse(self):
        node = self.expr(0)
        token = self.peek()
        if token.kind != "eof":
            raise ParseError(
                got=token.text, expected="end of input", span=token.span
            )
        return node

    def expr(self, rbp):
        left = self.nud(self.advance())
        while _lbp(self.peek()) > rbp:
            left = self.led(self.advance(), left)
        return left

    # -- null denotation (prefix position) --------------------------------
    def nud(self, token):
        if token.kind == "int":
            return {
                "op": "int",
                "value": int(token.text),
                "lbp": 0,
                "rbp": 0,
                "span": [token.start, token.end],
            }
        if token.kind == "ident":
            return {
                "op": "ident",
                "name": token.text,
                "lbp": 0,
                "rbp": 0,
                "span": [token.start, token.end],
            }
        if token.kind == "op":
            if token.text == "(":
                node = self.expr(0)
                self.expect(")")
                return node
            if token.text in _PREFIX_OPS:
                operand = self.expr(_UNARY_RBP)
                return {
                    "op": _PREFIX_OPS[token.text],
                    "operand": operand,
                    "lbp": 0,
                    "rbp": _UNARY_RBP,
                    "span": [token.start, operand["span"][1]],
                }
        raise ParseError(got=token.text, expected="expression", span=token.span)

    # -- left denotation (infix/postfix position) --------------------------
    def led(self, token, left):
        text = token.text
        if text in _INFIX:
            lbp, rbp = _INFIX[text]
            right = self.expr(rbp)
            return {
                "op": text,
                "left": left,
                "right": right,
                "lbp": lbp,
                "rbp": rbp,
                "span": [left["span"][0], right["span"][1]],
            }
        if text == "?":
            then = self.expr(0)
            self.expect(":")
            otherwise = self.expr(_TERNARY_RBP)
            return {
                "op": "?:",
                "cond": left,
                "then": then,
                "else": otherwise,
                "lbp": _TERNARY_LBP,
                "rbp": _TERNARY_RBP,
                "span": [left["span"][0], otherwise["span"][1]],
            }
        if text == "(":
            args = []
            if not (self.peek().kind == "op" and self.peek().text == ")"):
                args.append(self.expr(0))
                while self.peek().kind == "op" and self.peek().text == ",":
                    self.advance()
                    args.append(self.expr(0))
            close = self.expect(")")
            return {
                "op": "call",
                "func": left,
                "args": args,
                "lbp": _POSTFIX_LBP,
                "rbp": 0,
                "span": [left["span"][0], close.end],
            }
        if text == "[":
            index = self.expr(0)
            close = self.expect("]")
            return {
                "op": "[]",
                "obj": left,
                "index": index,
                "lbp": _POSTFIX_LBP,
                "rbp": 0,
                "span": [left["span"][0], close.end],
            }
        raise ParseError(got=text, expected="operator", span=token.span)


def parse(src):
    """Parse *src* and return the AST (a JSON-serializable dict)."""
    return Parser(src).parse()
