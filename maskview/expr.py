"""Boolean filter expressions with SQL-style three-valued logic.

Grammar (keywords are case-insensitive)::

    or_expr  := and_expr (OR and_expr)*
    and_expr := not_expr (AND not_expr)*
    not_expr := NOT not_expr | comparison
    comparison := primary ((==|!=|<|<=|>|>=) primary)?
    primary  := NUMBER | STRING | true | false | null
              | IDENT | '(' or_expr ')'

Semantics:
  * Identifiers must name a schema column, otherwise E_SCHEMA.
  * Any comparison involving ``null`` (or an UNKNOWN operand) yields
    the UNKNOWN truth value.
  * UNKNOWN is never silently treated as false: when a filter or a
    ``when`` clause evaluates to UNKNOWN the caller raises E_EVAL.
"""

from __future__ import annotations

import ast
import re

from .errors import PolicyError


class _Unknown:
    """Singleton third truth value."""

    def __repr__(self):  # pragma: no cover - debugging aid
        return "UNKNOWN"

    def __bool__(self):
        raise PolicyError("E_EVAL", "UNKNOWN has no boolean value")


UNKNOWN = _Unknown()

_TOKEN_RE = re.compile(
    r"\s*(?:"
    r"(?P<number>-?\d+(?:\.\d+)?)"
    r"|(?P<string>'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")"
    r"|(?P<op>==|!=|<=|>=|<|>|\(|\))"
    r"|(?P<ident>[A-Za-z_][A-Za-z0-9_]*)"
    r")"
)

_KEYWORDS = {"and", "or", "not", "true", "false", "null"}


def _tokenize(text):
    tokens = []
    pos = 0
    while pos < len(text):
        if text[pos:].strip() == "":
            break
        match = _TOKEN_RE.match(text, pos)
        if match is None or match.end() == pos:
            raise PolicyError("E_PARSE", "cannot tokenize expression near %r" % text[pos:pos + 20])
        pos = match.end()
        kind = match.lastgroup
        tokens.append((kind, match.group(kind)))
    return tokens


class _Parser:
    def __init__(self, tokens, columns):
        self.tokens = tokens
        self.pos = 0
        self.columns = columns

    def peek(self):
        if self.pos < len(self.tokens):
            return self.tokens[self.pos]
        return None

    def advance(self):
        tok = self.peek()
        if tok is None:
            raise PolicyError("E_PARSE", "unexpected end of expression")
        self.pos += 1
        return tok

    def parse_or(self):
        node = self.parse_and()
        while self._at_keyword("or"):
            self.advance()
            node = ("or", node, self.parse_and())
        return node

    def parse_and(self):
        node = self.parse_not()
        while self._at_keyword("and"):
            self.advance()
            node = ("and", node, self.parse_not())
        return node

    def parse_not(self):
        if self._at_keyword("not"):
            self.advance()
            return ("not", self.parse_not())
        return self.parse_comparison()

    def parse_comparison(self):
        left = self.parse_primary()
        tok = self.peek()
        if tok is not None and tok[0] == "op" and tok[1] in ("==", "!=", "<", "<=", ">", ">="):
            self.advance()
            right = self.parse_primary()
            return ("cmp", tok[1], left, right)
        return left

    def parse_primary(self):
        tok = self.advance()
        kind, value = tok
        if kind == "number":
            return ("lit", float(value) if "." in value else int(value))
        if kind == "string":
            try:
                return ("lit", ast.literal_eval(value))
            except (ValueError, SyntaxError) as exc:
                raise PolicyError("E_PARSE", "bad string literal %r" % value) from exc
        if kind == "op" and value == "(":
            node = self.parse_or()
            closing = self.advance()
            if closing != ("op", ")"):
                raise PolicyError("E_PARSE", "expected ')'")
            return node
        if kind == "ident":
            lowered = value.lower()
            if lowered == "true":
                return ("lit", True)
            if lowered == "false":
                return ("lit", False)
            if lowered == "null":
                return ("lit", None)
            if lowered in _KEYWORDS:
                raise PolicyError("E_PARSE", "unexpected keyword %r" % value)
            if value not in self.columns:
                raise PolicyError("E_SCHEMA", "unknown column %r in expression" % value)
            return ("col", value)
        raise PolicyError("E_PARSE", "unexpected token %r" % (value,))

    def _at_keyword(self, word):
        tok = self.peek()
        return tok is not None and tok[0] == "ident" and tok[1].lower() == word


def parse(text, columns):
    """Parse ``text`` into an AST, validating identifiers against ``columns``."""
    if not isinstance(text, str) or not text.strip():
        raise PolicyError("E_PARSE", "expression must be a non-empty string")
    parser = _Parser(_tokenize(text), set(columns))
    node = parser.parse_or()
    if parser.peek() is not None:
        raise PolicyError("E_PARSE", "trailing token %r" % (parser.peek()[1],))
    return node


def _as_bool(value):
    if value is UNKNOWN:
        return UNKNOWN
    if isinstance(value, bool):
        return value
    raise PolicyError("E_EVAL", "expected boolean operand, got %r" % (value,))


def _logic_not(value):
    value = _as_bool(value)
    if value is UNKNOWN:
        return UNKNOWN
    return not value


def _logic_and(left, right):
    left = _as_bool(left)
    right = _as_bool(right)
    if left is False or right is False:
        return False
    if left is UNKNOWN or right is UNKNOWN:
        return UNKNOWN
    return True


def _logic_or(left, right):
    left = _as_bool(left)
    right = _as_bool(right)
    if left is True or right is True:
        return True
    if left is UNKNOWN or right is UNKNOWN:
        return UNKNOWN
    return False


def _compare(op, left, right):
    if left is UNKNOWN or right is UNKNOWN or left is None or right is None:
        return UNKNOWN
    try:
        if op == "==":
            return left == right
        if op == "!=":
            return left != right
        if op == "<":
            return left < right
        if op == "<=":
            return left <= right
        if op == ">":
            return left > right
        if op == ">=":
            return left >= right
    except TypeError as exc:
        raise PolicyError("E_EVAL", "cannot compare %r %s %r" % (left, op, right)) from exc
    raise PolicyError("E_PARSE", "unknown operator %r" % op)  # pragma: no cover


def evaluate(node, row):
    """Evaluate AST ``node`` against mapping ``row``.

    Returns a Python value for literals/columns, or True/False/UNKNOWN
    for boolean expressions.
    """
    kind = node[0]
    if kind == "lit":
        return node[1]
    if kind == "col":
        return row.get(node[1])
    if kind == "not":
        return _logic_not(evaluate(node[1], row))
    if kind == "and":
        return _logic_and(evaluate(node[1], row), evaluate(node[2], row))
    if kind == "or":
        return _logic_or(evaluate(node[1], row), evaluate(node[2], row))
    if kind == "cmp":
        return _compare(node[1], evaluate(node[2], row), evaluate(node[3], row))
    raise PolicyError("E_PARSE", "bad expression node %r" % (kind,))  # pragma: no cover
