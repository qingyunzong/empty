"""lexpat: a mode-stack lexer with longest-match semantics.

A spec is a JSON object ``{"rules": [...]}`` where each rule is::

    {"name": "IDENT", "regex": "[a-z]+", "mode": "main",
     "push": "other_mode", "pop": false, "skip": false}

- ``mode``  : rule is active only in this mode (default ``"main"``).
- ``push``  : after matching, push this mode onto the mode stack.
- ``pop``   : after matching, pop the mode stack.
- ``skip``  : match is consumed but no token is emitted.

At each input position every rule of the current mode is tried; the
longest match wins, ties are broken by rule order (lowest index first).
Regular expressions use :mod:`re` but capturing groups are forbidden.
"""

from __future__ import annotations

import bisect
import json
import re

__all__ = [
    "LexError",
    "Rule",
    "Spec",
    "Token",
    "lex",
    "load_spec",
    "MAX_STACK_DEPTH",
    "START_MODE",
]

MAX_STACK_DEPTH = 64
START_MODE = "main"

_RULE_KEYS = frozenset({"name", "regex", "mode", "push", "pop", "skip"})


class LexError(Exception):
    """Raised when the input cannot be lexed.

    Carries ``line``/``col`` (1-based), the active ``mode`` and the
    ``expected`` rule names for that mode.
    """

    def __init__(self, message, line, col, mode, expected):
        super().__init__(message)
        self.message = message
        self.line = line
        self.col = col
        self.mode = mode
        self.expected = list(expected)

    def to_dict(self):
        return {
            "error": self.message,
            "line": self.line,
            "col": self.col,
            "mode": self.mode,
            "expected": self.expected,
        }


class Rule:
    __slots__ = ("name", "pattern", "mode", "push", "pop", "skip", "order", "compiled")

    def __init__(self, name, pattern, mode=START_MODE, push=None, pop=False,
                 skip=False, order=0):
        self.name = name
        self.pattern = pattern
        self.mode = mode
        self.push = push
        self.pop = pop
        self.skip = skip
        self.order = order
        self.compiled = re.compile(pattern)

    def __repr__(self):
        return f"Rule({self.name!r}, {self.pattern!r}, mode={self.mode!r})"


class Spec:
    """A validated lexer specification."""

    def __init__(self, rules):
        if not isinstance(rules, list) or not rules:
            raise ValueError("spec must contain a non-empty 'rules' list")
        self.rules = []
        self.by_mode = {}
        for order, raw in enumerate(rules):
            rule = self._build_rule(raw, order)
            self.rules.append(rule)
            self.by_mode.setdefault(rule.mode, []).append(rule)

    @staticmethod
    def _build_rule(raw, order):
        if not isinstance(raw, dict):
            raise ValueError(f"rule #{order} must be an object")
        unknown = set(raw) - _RULE_KEYS
        if unknown:
            raise ValueError(f"rule #{order} has unknown keys: {sorted(unknown)}")
        name = raw.get("name")
        if not isinstance(name, str) or not name:
            raise ValueError(f"rule #{order} needs a non-empty string 'name'")
        pattern = raw.get("regex")
        if not isinstance(pattern, str):
            raise ValueError(f"rule {name!r} needs a 'regex' string")
        mode = raw.get("mode", START_MODE)
        if not isinstance(mode, str) or not mode:
            raise ValueError(f"rule {name!r} has an invalid 'mode'")
        push = raw.get("push")
        if push is not None and (not isinstance(push, str) or not push):
            raise ValueError(f"rule {name!r} has an invalid 'push' mode")
        pop = bool(raw.get("pop", False))
        skip = bool(raw.get("skip", False))
        if push is not None and pop:
            raise ValueError(f"rule {name!r} cannot both 'push' and 'pop'")
        try:
            compiled = re.compile(pattern)
        except re.error as exc:
            raise ValueError(f"rule {name!r} has an invalid regex: {exc}") from exc
        if compiled.groups:
            raise ValueError(
                f"rule {name!r} must not contain capturing groups; "
                "use (?:...) instead"
            )
        return Rule(name, pattern, mode=mode, push=push, pop=pop,
                    skip=skip, order=order)


def load_spec(path):
    """Load a :class:`Spec` from a JSON file."""
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or "rules" not in data:
        raise ValueError("spec file must be a JSON object with a 'rules' key")
    return Spec(data["rules"])


class Token:
    __slots__ = ("type", "text", "line", "col", "mode_before", "mode_after")

    def __init__(self, type, text, line, col, mode_before, mode_after):
        self.type = type
        self.text = text
        self.line = line
        self.col = col
        self.mode_before = mode_before
        self.mode_after = mode_after

    def to_dict(self):
        return {
            "type": self.type,
            "text": self.text,
            "line": self.line,
            "col": self.col,
            "mode_before": self.mode_before,
            "mode_after": self.mode_after,
        }

    def __repr__(self):
        return f"Token({self.type!r}, {self.text!r}, {self.line}:{self.col})"


def lex(text, spec):
    """Lex ``text`` according to ``spec`` and return a list of :class:`Token`.

    Raises :class:`LexError` on empty matches, unknown characters,
    unterminated constructs (EOF in a non-start mode), mode-stack
    overflow and popping an empty mode stack.
    """
    line_starts = [0]
    for match in re.finditer("\n", text):
        line_starts.append(match.end())

    def linecol(pos):
        line = bisect.bisect_right(line_starts, pos)
        return line, pos - line_starts[line - 1] + 1

    stack = [START_MODE]
    tokens = []
    pos = 0
    end = len(text)
    while pos < end:
        mode = stack[-1]
        mode_rules = spec.by_mode.get(mode, [])
        best_rule = None
        best_len = -1
        for rule in mode_rules:
            match = rule.compiled.match(text, pos)
            if match is None:
                continue
            length = match.end() - pos
            if length > best_len:  # first rule wins ties (strictly greater)
                best_len = length
                best_rule = rule
        line, col = linecol(pos)
        if best_rule is None:
            raise LexError(
                f"unexpected character {text[pos]!r}",
                line, col, mode, [r.name for r in mode_rules],
            )
        if best_len == 0:
            raise LexError(
                f"rule {best_rule.name!r} matched the empty string",
                line, col, mode, [best_rule.name],
            )
        mode_before = mode
        if best_rule.push is not None:
            if len(stack) >= MAX_STACK_DEPTH:
                raise LexError(
                    f"mode stack overflow (limit {MAX_STACK_DEPTH})",
                    line, col, mode, [best_rule.name],
                )
            stack.append(best_rule.push)
        elif best_rule.pop:
            if len(stack) <= 1:
                raise LexError(
                    "pop from empty mode stack",
                    line, col, mode, [best_rule.name],
                )
            stack.pop()
        if not best_rule.skip:
            tokens.append(Token(best_rule.name, text[pos:pos + best_len],
                                line, col, mode_before, stack[-1]))
        pos += best_len
    if len(stack) > 1:
        line, col = linecol(end)
        mode = stack[-1]
        raise LexError(
            f"unterminated construct: end of input in mode {mode!r}",
            line, col, mode, [r.name for r in spec.by_mode.get(mode, [])],
        )
    return tokens
