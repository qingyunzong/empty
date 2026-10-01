"""lexpat: a nested-mode, longest-match lexer library.

A spec is a JSON object ``{"rules": [...]}`` where each rule is::

    {"name": str, "regex": str, "mode": str = "main",
     "push": str | None, "pop": bool = False, "skip": bool = False}

Lexing starts in mode ``main``.  At every input position every rule of
the current mode is tried; the longest match wins and ties are broken by
rule order.  ``push``/``pop`` manipulate a mode stack (max depth 64,
pop applied before push when both are set).  Regexes are compiled with
:mod:`re` and must not contain capturing groups.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = ["LexError", "Lexer", "Rule", "tokenize", "MAX_DEPTH", "START_MODE"]

MAX_DEPTH = 64
START_MODE = "main"


class LexError(Exception):
    """Lexical error carrying source position and context."""

    def __init__(self, message, line=None, col=None, mode=None, expected=None):
        super().__init__(message)
        self.message = message
        self.line = line
        self.col = col
        self.mode = mode
        self.expected = list(expected) if expected else []

    def to_dict(self):
        return {
            "error": self.message,
            "line": self.line,
            "col": self.col,
            "mode": self.mode,
            "expected": self.expected,
        }


@dataclass(frozen=True)
class Rule:
    name: str
    pattern: str
    mode: str
    push: "str | None"
    pop: bool
    skip: bool
    regex: "re.Pattern"
    order: int


class Lexer:
    """Compiled lexer built from a spec dict."""

    def __init__(self, spec):
        if not isinstance(spec, dict):
            raise LexError("spec must be a JSON object")
        raw_rules = spec.get("rules")
        if not isinstance(raw_rules, list) or not raw_rules:
            raise LexError("spec must contain a non-empty 'rules' array")
        self.rules_by_mode = {}
        for order, raw in enumerate(raw_rules):
            rule = self._compile_rule(raw, order)
            self.rules_by_mode.setdefault(rule.mode, []).append(rule)

    @staticmethod
    def _compile_rule(raw, order):
        if not isinstance(raw, dict):
            raise LexError(f"rule #{order} must be an object")
        name = raw.get("name")
        pattern = raw.get("regex")
        if not isinstance(name, str) or not name:
            raise LexError(f"rule #{order}: 'name' must be a non-empty string")
        if not isinstance(pattern, str):
            raise LexError(f"rule {name!r}: 'regex' must be a string")
        mode = raw.get("mode", START_MODE)
        push = raw.get("push")
        pop = bool(raw.get("pop", False))
        skip = bool(raw.get("skip", False))
        if not isinstance(mode, str) or not mode:
            raise LexError(f"rule {name!r}: 'mode' must be a non-empty string")
        if push is not None and not isinstance(push, str):
            raise LexError(f"rule {name!r}: 'push' must be a string")
        try:
            compiled = re.compile(pattern)
        except re.error as exc:
            raise LexError(f"rule {name!r}: invalid regex: {exc}") from exc
        if compiled.groups:
            raise LexError(
                f"rule {name!r}: capturing groups are forbidden; use (?:...) instead"
            )
        return Rule(
            name=name,
            pattern=pattern,
            mode=mode,
            push=push,
            pop=pop,
            skip=skip,
            regex=compiled,
            order=order,
        )

    def tokenize(self, text):
        """Tokenize ``text`` and return a list of token dicts.

        Raises :class:`LexError` on empty matches, unknown characters,
        unterminated constructs, and mode-stack underflow/overflow.
        """
        if not isinstance(text, str):
            raise TypeError("text must be str")
        stack = [START_MODE]
        tokens = []
        pos = 0
        line = 1
        col = 1
        n = len(text)
        while pos < n:
            mode = stack[-1]
            rules = self.rules_by_mode.get(mode)
            if not rules:
                raise LexError(f"no rules defined for mode {mode!r}", line, col, mode)
            best_rule = None
            best_text = None
            best_len = -1
            for rule in rules:
                match = rule.regex.match(text, pos)
                if match is None:
                    continue
                length = match.end() - pos
                if length > best_len:
                    best_len = length
                    best_rule = rule
                    best_text = match.group(0)
            expected = [rule.name for rule in rules]
            if best_rule is None:
                raise LexError(
                    f"unexpected character {text[pos]!r}", line, col, mode, expected
                )
            if best_len == 0:
                raise LexError(
                    f"rule {best_rule.name!r} matched the empty string",
                    line,
                    col,
                    mode,
                    expected,
                )
            mode_before = mode
            if best_rule.pop:
                if len(stack) == 1:
                    raise LexError(
                        f"rule {best_rule.name!r}: pop from empty mode stack",
                        line,
                        col,
                        mode,
                        expected,
                    )
                stack.pop()
            if best_rule.push is not None:
                if len(stack) >= MAX_DEPTH:
                    raise LexError(
                        f"rule {best_rule.name!r}: mode stack overflow "
                        f"(max depth {MAX_DEPTH})",
                        line,
                        col,
                        mode,
                        expected,
                    )
                stack.append(best_rule.push)
            mode_after = stack[-1]
            if not best_rule.skip:
                tokens.append(
                    {
                        "type": best_rule.name,
                        "text": best_text,
                        "line": line,
                        "col": col,
                        "mode_before": mode_before,
                        "mode_after": mode_after,
                    }
                )
            newlines = best_text.count("\n")
            if newlines:
                line += newlines
                col = len(best_text) - best_text.rfind("\n")
            else:
                col += best_len
            pos += best_len
        if len(stack) != 1:
            mode = stack[-1]
            expected = [rule.name for rule in self.rules_by_mode.get(mode, [])]
            raise LexError(
                f"unterminated construct: mode {mode!r} still open at end of input",
                line,
                col,
                mode,
                expected,
            )
        return tokens


def tokenize(text, spec):
    """Convenience wrapper: ``Lexer(spec).tokenize(text)``."""
    return Lexer(spec).tokenize(text)
