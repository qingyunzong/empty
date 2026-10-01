"""Recursive-descent parser + resolver for the shadowc policy DSL.

Grammar (whitespace separated, ``#`` starts a line comment)::

    policy   := (field_decl | action_decl | rule)*
    field_decl := "field" IDENT ":" ("int" | "string" | "enum" "(" IDENT ("," IDENT)* ")")
    action_decl := "action" IDENT
    rule     := "rule" IDENT "when" cond "then" IDENT ("," IDENT)*
    cond     := or_expr
    or_expr  := and_expr ("or" and_expr)*
    and_expr := unary ("and" unary)*
    unary    := "not" unary | "(" cond ")" | atom
    atom     := IDENT "in" INT ".." INT
              | IDENT "in" "{" value ("," value)* "}"
              | IDENT "==" value
    value    := INT | STRING | IDENT

Resolution (unknown fields/actions/enum values, type mismatches, empty
intervals, misplaced wildcards) is done while parsing; every failure raises
``PolicyError`` with code ``E_PARSE`` and an accurate position.
"""

from __future__ import annotations

from .errors import PolicyError
from .lexer import Token, lex
from .nodes import (
    And,
    EnumValues,
    FieldDecl,
    FieldType,
    Interval,
    IntValues,
    Not,
    Or,
    Policy,
    Rule,
    StrPatterns,
)


class _Parser:
    def __init__(self, tokens: list):
        self.toks = tokens
        self.pos = 0
        self.policy = Policy()
        self.fields: dict = {}
        self.actions: set = set()
        self.rule_names: set = set()

    # -- token helpers -------------------------------------------------

    def peek(self) -> Token:
        return self.toks[self.pos]

    def advance(self) -> Token:
        tok = self.toks[self.pos]
        self.pos += 1
        return tok

    def error(self, message: str, tok: Token) -> None:
        raise PolicyError("E_PARSE", message, tok.line, tok.col)

    def is_keyword(self, tok: Token, word: str) -> bool:
        return tok.kind == "KEYWORD" and tok.value == word

    def accept_keyword(self, word: str):
        tok = self.peek()
        if self.is_keyword(tok, word):
            self.advance()
            return tok
        return None

    def expect_keyword(self, word: str) -> Token:
        tok = self.peek()
        if not self.is_keyword(tok, word):
            self.error(f"expected {word!r}, got {tok.describe()}", tok)
        return self.advance()

    def is_punct(self, tok: Token, p: str) -> bool:
        return tok.kind == "PUNCT" and tok.value == p

    def accept_punct(self, p: str):
        tok = self.peek()
        if self.is_punct(tok, p):
            self.advance()
            return tok
        return None

    def expect_punct(self, p: str) -> Token:
        tok = self.peek()
        if not self.is_punct(tok, p):
            self.error(f"expected {p!r}, got {tok.describe()}", tok)
        return self.advance()

    def expect_ident(self, what: str) -> Token:
        tok = self.peek()
        if tok.kind != "IDENT":
            self.error(f"expected {what}, got {tok.describe()}", tok)
        return self.advance()

    # -- top level ------------------------------------------------------

    def parse(self) -> Policy:
        while self.peek().kind != "EOF":
            tok = self.peek()
            if self.is_keyword(tok, "field"):
                self.parse_field_decl()
            elif self.is_keyword(tok, "action"):
                self.parse_action_decl()
            elif self.is_keyword(tok, "rule"):
                self.parse_rule()
            else:
                self.error(
                    "expected 'field', 'action' or 'rule', " f"got {tok.describe()}",
                    tok,
                )
        return self.policy

    def parse_field_decl(self) -> None:
        self.expect_keyword("field")
        name_tok = self.expect_ident("field name")
        self.expect_punct(":")
        type_tok = self.peek()
        if self.accept_keyword("int"):
            ftype = FieldType("int")
        elif self.accept_keyword("string"):
            ftype = FieldType("string")
        elif self.accept_keyword("enum"):
            self.expect_punct("(")
            domain = [self.expect_ident("enum value").value]
            while self.accept_punct(","):
                domain.append(self.expect_ident("enum value").value)
            self.expect_punct(")")
            if len(set(domain)) != len(domain):
                self.error("duplicate value in enum domain", type_tok)
            ftype = FieldType("enum", tuple(domain))
        else:
            self.error(
                f"expected field type 'int', 'string' or 'enum', got {type_tok.describe()}",
                type_tok,
            )
        if name_tok.value in self.fields:
            self.error(f"duplicate field {name_tok.value!r}", name_tok)
        decl = FieldDecl(name_tok.value, ftype, name_tok.line, name_tok.col)
        self.fields[name_tok.value] = ftype
        self.policy.fields.append(decl)

    def parse_action_decl(self) -> None:
        self.expect_keyword("action")
        name_tok = self.expect_ident("action name")
        if name_tok.value in self.actions:
            self.error(f"duplicate action {name_tok.value!r}", name_tok)
        self.actions.add(name_tok.value)
        self.policy.actions.append(name_tok.value)

    def parse_rule(self) -> None:
        rule_tok = self.expect_keyword("rule")
        name_tok = self.expect_ident("rule name")
        if name_tok.value in self.rule_names:
            self.error(f"duplicate rule {name_tok.value!r}", name_tok)
        self.rule_names.add(name_tok.value)
        self.expect_keyword("when")
        cond = self.parse_or()
        self.expect_keyword("then")
        actions = [self.parse_action_ref()]
        while self.accept_punct(","):
            actions.append(self.parse_action_ref())
        self.policy.rules.append(
            Rule(name_tok.value, cond, actions, rule_tok.line, rule_tok.col)
        )

    def parse_action_ref(self) -> str:
        tok = self.peek()
        if tok.kind != "IDENT":
            self.error(
                "empty rule body: expected at least one action after 'then', "
                f"got {tok.describe()}",
                tok,
            )
        self.advance()
        if tok.value not in self.actions:
            self.error(f"unknown action {tok.value!r}", tok)
        return tok.value

    # -- conditions -----------------------------------------------------

    def parse_or(self):
        node = self.parse_and()
        while self.accept_keyword("or"):
            node = Or(node, self.parse_and())
        return node

    def parse_and(self):
        node = self.parse_unary()
        while self.accept_keyword("and"):
            node = And(node, self.parse_unary())
        return node

    def parse_unary(self):
        if self.accept_keyword("not"):
            return Not(self.parse_unary())
        if self.accept_punct("("):
            node = self.parse_or()
            self.expect_punct(")")
            return node
        return self.parse_atom()

    def parse_atom(self):
        field_tok = self.expect_ident("field name")
        field = field_tok.value
        if self.accept_keyword("in"):
            if self.accept_punct("{"):
                values = [self.parse_value()]
                while self.accept_punct(","):
                    values.append(self.parse_value())
                self.expect_punct("}")
                return self.build_value_set(field, values, field_tok)
            lo_tok = self.peek()
            if lo_tok.kind != "INT":
                self.error(f"expected integer interval bound, got {lo_tok.describe()}", lo_tok)
            self.advance()
            self.expect_punct("..")
            hi_tok = self.peek()
            if hi_tok.kind != "INT":
                self.error(f"expected integer interval bound, got {hi_tok.describe()}", hi_tok)
            self.advance()
            return self.build_interval(field, int(lo_tok.value), int(hi_tok.value), field_tok, lo_tok)
        self.expect_punct("==")
        value = self.parse_value()
        return self.build_value_set(field, [value], field_tok)

    def parse_value(self):
        tok = self.peek()
        if tok.kind == "INT":
            self.advance()
            return ("int", int(tok.value), tok)
        if tok.kind == "STRING":
            self.advance()
            return ("string", tok.value, tok)
        if tok.kind == "IDENT":
            self.advance()
            return ("ident", tok.value, tok)
        self.error(f"expected a value, got {tok.describe()}", tok)

    # -- resolution / type checking --------------------------------------

    def field_type(self, field: str, tok: Token) -> FieldType:
        ftype = self.fields.get(field)
        if ftype is None:
            self.error(f"unknown field {field!r}", tok)
        return ftype

    def build_interval(self, field, lo, hi, field_tok, lo_tok):
        ftype = self.field_type(field, field_tok)
        if ftype.kind != "int":
            self.error(
                f"field {field!r} has type {ftype.kind}; intervals require an int field",
                field_tok,
            )
        if lo > hi:
            self.error(f"empty interval {lo}..{hi} (lower bound exceeds upper bound)", lo_tok)
        return Interval(field, lo, hi, field_tok.line, field_tok.col)

    def build_value_set(self, field, values, field_tok):
        ftype = self.field_type(field, field_tok)
        if ftype.kind == "int":
            ints = []
            for kind, val, vtok in values:
                if kind != "int":
                    self.error(
                        f"field {field!r} has type int; expected an integer value",
                        vtok,
                    )
                ints.append(val)
            return IntValues(field, frozenset(ints), field_tok.line, field_tok.col)
        if ftype.kind == "string":
            patterns = []
            for kind, val, vtok in values:
                if kind == "int":
                    self.error(
                        f"field {field!r} has type string; expected a string value",
                        vtok,
                    )
                if kind == "ident":
                    patterns.append((val, False))
                else:
                    patterns.append(self.make_pattern(val, vtok))
            return StrPatterns(field, tuple(patterns), field_tok.line, field_tok.col)
        # enum
        names = []
        for kind, val, vtok in values:
            if kind != "ident":
                self.error(
                    f"field {field!r} is an enum; expected one of "
                    + ", ".join(repr(v) for v in ftype.domain),
                    vtok,
                )
            if val not in ftype.domain:
                self.error(
                    f"unknown value {val!r} for enum field {field!r} "
                    f"(domain: {', '.join(ftype.domain)})",
                    vtok,
                )
            names.append(val)
        return EnumValues(field, frozenset(names), field_tok.line, field_tok.col)

    def make_pattern(self, text, tok):
        if "*" in text[:-1]:
            self.error("wildcard '*' is only allowed at the end of a string pattern", tok)
        if text.endswith("*"):
            return (text[:-1], True)
        return (text, False)


def parse_policy(source: str) -> Policy:
    """Parse and resolve a policy source string into a Policy AST."""
    return _Parser(lex(source)).parse()
