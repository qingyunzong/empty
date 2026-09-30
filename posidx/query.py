"""Boolean + phrase query parsing and evaluation.

Grammar (case-insensitive operators, precedence NOT > AND > OR)::

    expr     := or_expr
    or_expr  := and_expr (OR and_expr)*
    and_expr := not_expr (AND not_expr)*
    not_expr := NOT not_expr | primary
    primary  := "(" expr ")" | phrase | term
    phrase   := '"' ... '"'   (tokenized like document text)
    term     := any run of non-space, non-paren, non-quote chars
"""

from __future__ import annotations

from .index import PositionalIndex, tokenize


class QuerySyntaxError(Exception):
    """Raised when a query string cannot be parsed."""


# AST nodes are tuples:
#   ("term", term)
#   ("phrase", [term, ...])
#   ("and", left, right) / ("or", left, right)
#   ("not", operand)

_OPERATORS = {"and", "or", "not"}


def _lex(text: str) -> list[tuple]:
    tokens: list[tuple] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch.isspace():
            i += 1
        elif ch == "(":
            tokens.append(("LPAREN",))
            i += 1
        elif ch == ")":
            tokens.append(("RPAREN",))
            i += 1
        elif ch == '"':
            j = text.find('"', i + 1)
            if j == -1:
                raise QuerySyntaxError("unterminated phrase")
            tokens.append(("PHRASE", text[i + 1 : j]))
            i = j + 1
        else:
            j = i
            while j < n and not text[j].isspace() and text[j] not in '()"':
                j += 1
            tokens.append(("WORD", text[i:j]))
            i = j
    return tokens


class _Parser:
    def __init__(self, tokens: list[tuple]):
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> tuple | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def advance(self) -> tuple:
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def parse(self):
        if not self.tokens:
            raise QuerySyntaxError("empty query")
        node = self.parse_or()
        if self.pos != len(self.tokens):
            raise QuerySyntaxError("unexpected trailing input")
        return node

    def parse_or(self):
        node = self.parse_and()
        while self._accept_op("or"):
            rhs = self.parse_and()
            node = ("or", node, rhs)
        return node

    def parse_and(self):
        node = self.parse_not()
        while self._accept_op("and"):
            rhs = self.parse_not()
            node = ("and", node, rhs)
        return node

    def parse_not(self):
        if self._accept_op("not"):
            return ("not", self.parse_not())
        return self.parse_primary()

    def parse_primary(self):
        tok = self.peek()
        if tok is None:
            raise QuerySyntaxError("unexpected end of query")
        kind = tok[0]
        if kind == "LPAREN":
            self.advance()
            node = self.parse_or()
            if self.peek() != ("RPAREN",):
                raise QuerySyntaxError("missing closing parenthesis")
            self.advance()
            return node
        if kind == "PHRASE":
            self.advance()
            terms = tokenize(tok[1])
            if not terms:
                raise QuerySyntaxError("phrase contains no searchable terms")
            if len(terms) == 1:
                return ("term", terms[0])
            return ("phrase", terms)
        if kind == "WORD":
            self.advance()
            word = tok[1]
            if word.lower() in _OPERATORS:
                raise QuerySyntaxError(f"unexpected operator {word!r}")
            terms = tokenize(word)
            if not terms:
                raise QuerySyntaxError(f"term {word!r} has no searchable text")
            if len(terms) == 1:
                return ("term", terms[0])
            # Punctuation inside a word splits it into several tokens; treat
            # it as an implicit phrase so behaviour stays predictable.
            return ("phrase", terms)
        raise QuerySyntaxError("unexpected token")

    def _accept_op(self, op: str) -> bool:
        tok = self.peek()
        if tok is not None and tok[0] == "WORD" and tok[1].lower() == op:
            self.advance()
            return True
        return False


def parse_query(text: str):
    """Parse *text* into a query AST; raises QuerySyntaxError."""
    if not isinstance(text, str):
        raise QuerySyntaxError("query must be a string")
    return _Parser(_lex(text)).parse()


def _phrase_docs(terms: list[str], index: PositionalIndex) -> set[str]:
    postings = [index.postings(t) for t in terms]
    if any(not p for p in postings):
        return set()
    candidates = set.intersection(*(set(p) for p in postings))
    hits: set[str] = set()
    for doc_id in candidates:
        # Positions where a match could still continue, walking left to right.
        current = set(postings[0][doc_id])
        for posting in postings[1:]:
            nxt = set(posting[doc_id])
            current = {p + 1 for p in current if p + 1 in nxt}
            if not current:
                break
        if current:
            hits.add(doc_id)
    return hits


def evaluate(node, index: PositionalIndex) -> set[str]:
    """Evaluate a parsed query AST against *index*, returning doc ids."""
    kind = node[0]
    if kind == "term":
        return set(index.postings(node[1]))
    if kind == "phrase":
        return _phrase_docs(node[1], index)
    if kind == "and":
        return evaluate(node[1], index) & evaluate(node[2], index)
    if kind == "or":
        return evaluate(node[1], index) | evaluate(node[2], index)
    if kind == "not":
        return index.doc_ids() - evaluate(node[1], index)
    raise QuerySyntaxError(f"unknown query node {kind!r}")


def search(index: PositionalIndex, query_text: str) -> set[str]:
    """Parse and evaluate *query_text* against *index*."""
    return evaluate(parse_query(query_text), index)
