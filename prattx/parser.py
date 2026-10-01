"""Pratt (top-down operator precedence) parser.

Precedence table (higher binds tighter):

    100  call f(...) / index a[...]      (postfix)
     90  **                               (right assoc, rbp 89)
     80  unary + - !                      (prefix, rbp 80)
     70  * / %
     60  + -
     50  == != < <= > >=
     40  &&
     30  ||
     20  ?:                                (right assoc, rbp 19)
     10  =                                (right assoc, rbp 9, lowest)

Because unary rbp (80) is below the lbp of ** (90), -2**2 parses as
-(2**2). Left-assoc operators use rbp == lbp; right-assoc use rbp == lbp-1.
"""

from .errors import ParseError
from .lexer import lex

UNARY_RBP = 80
PREFIX_OPS = {"+": UNARY_RBP, "-": UNARY_RBP, "!": UNARY_RBP}

# op -> (lbp, rbp); rbp < lbp means right associative.
BINARY_OPS = {
    "=": (10, 9),
    "||": (30, 30),
    "&&": (40, 40),
    "==": (50, 50),
    "!=": (50, 50),
    "<": (50, 50),
    "<=": (50, 50),
    ">": (50, 50),
    ">=": (50, 50),
    "+": (60, 60),
    "-": (60, 60),
    "*": (70, 70),
    "/": (70, 70),
    "%": (70, 70),
    "**": (90, 89),
}

TERNARY_LBP = 20
TERNARY_RBP = 19
POSTFIX_LBP = 100


class _Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0

    def _peek(self):
        return self.tokens[self.pos]

    def _advance(self):
        tok = self.tokens[self.pos]
        if tok.kind != "eof":
            self.pos += 1
        return tok

    def _at(self, text):
        tok = self._peek()
        return tok.kind == "op" and tok.text == text

    def _accept(self, text):
        if self._at(text):
            return self._advance()
        return None

    def _expect(self, text):
        tok = self._peek()
        if tok.kind == "op" and tok.text == text:
            return self._advance()
        raise ParseError(got=tok.text, expected="%r" % text, span=(tok.start, tok.end))

    def parse_expr(self, rbp):
        tok = self._advance()
        if tok.kind == "int":
            left = {
                "type": "int",
                "value": int(tok.text),
                "op": None,
                "lbp": 0,
                "rbp": 0,
                "span": [tok.start, tok.end],
            }
        elif tok.kind == "ident":
            left = {
                "type": "ident",
                "name": tok.text,
                "op": None,
                "lbp": 0,
                "rbp": 0,
                "span": [tok.start, tok.end],
            }
        elif tok.kind == "op" and tok.text in PREFIX_OPS:
            operand = self.parse_expr(PREFIX_OPS[tok.text])
            left = {
                "type": "unary",
                "op": tok.text,
                "lbp": None,
                "rbp": PREFIX_OPS[tok.text],
                "span": [tok.start, operand["span"][1]],
                "operand": operand,
            }
        elif tok.kind == "op" and tok.text == "(":
            # Grouping parentheses are consumed, never reified into the AST.
            left = self.parse_expr(0)
            self._expect(")")
        else:
            raise ParseError(
                got=tok.text, expected="expression", span=(tok.start, tok.end)
            )

        while True:
            tok = self._peek()
            if tok.kind != "op":
                break
            text = tok.text
            if text in BINARY_OPS and BINARY_OPS[text][0] > rbp:
                lbp, op_rbp = BINARY_OPS[text]
                self._advance()
                right = self.parse_expr(op_rbp)
                left = {
                    "type": "binary",
                    "op": text,
                    "lbp": lbp,
                    "rbp": op_rbp,
                    "span": [left["span"][0], right["span"][1]],
                    "left": left,
                    "right": right,
                }
            elif text == "?" and TERNARY_LBP > rbp:
                self._advance()
                then = self.parse_expr(0)
                self._expect(":")
                otherwise = self.parse_expr(TERNARY_RBP)
                left = {
                    "type": "ternary",
                    "op": "?:",
                    "lbp": TERNARY_LBP,
                    "rbp": TERNARY_RBP,
                    "span": [left["span"][0], otherwise["span"][1]],
                    "cond": left,
                    "then": then,
                    "else": otherwise,
                }
            elif text == "(" and POSTFIX_LBP > rbp:
                self._advance()
                args = []
                if not self._at(")"):
                    args.append(self.parse_expr(0))
                    while self._accept(","):
                        args.append(self.parse_expr(0))
                close = self._expect(")")
                left = {
                    "type": "call",
                    "op": "()",
                    "lbp": POSTFIX_LBP,
                    "rbp": None,
                    "span": [left["span"][0], close.end],
                    "func": left,
                    "args": args,
                }
            elif text == "[" and POSTFIX_LBP > rbp:
                self._advance()
                index = self.parse_expr(0)
                close = self._expect("]")
                left = {
                    "type": "index",
                    "op": "[]",
                    "lbp": POSTFIX_LBP,
                    "rbp": None,
                    "span": [left["span"][0], close.end],
                    "target": left,
                    "index": index,
                }
            else:
                break
        return left


def parse(source):
    """Parse *source* into an AST (nested dicts). Raises ParseError."""
    parser = _Parser(lex(source))
    node = parser.parse_expr(0)
    tok = parser._peek()
    if tok.kind != "eof":
        raise ParseError(
            got=tok.text, expected="end of input", span=(tok.start, tok.end)
        )
    return node
