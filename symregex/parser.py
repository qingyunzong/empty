"""正则表达式解析器（不依赖宿主正则引擎）。

语法（优先级从低到高）：
  union  := inter ("|" inter)*
  inter  := concat ("&" concat)*
  concat := repeat*
  repeat := ("~" repeat | atom) "*"*
  atom   := "(" union ")" | "." | "#" | "@" | "[" class "]" | "\\" ch | literal

  "."  字母表中任意字符      "#"/"∅"  空集        "@"/"ε"  空串
  "~"  补集（相对字母表）    "&"      交          "*"      Kleene 星
  字符类 [a-z]、[^a-z]（相对字母表取补）；反斜杠可转义任意非字母数字字符。
"""
from __future__ import annotations

from . import ast as A


class ParseError(ValueError):
    pass


class _Parser:
    def __init__(self, ctx, text):
        self.ctx = ctx
        self.text = text
        self.pos = 0

    def error(self, msg):
        raise ParseError(f"{msg} (position {self.pos} in {self.text!r})")

    def peek(self):
        return self.text[self.pos] if self.pos < len(self.text) else ""

    def next(self):
        ch = self.peek()
        if not ch:
            self.error("unexpected end of pattern")
        self.pos += 1
        return ch

    def parse(self):
        node = self.parse_union()
        if self.pos != len(self.text):
            self.error(f"unexpected character {self.peek()!r}")
        return node

    def parse_union(self):
        parts = [self.parse_inter()]
        while self.peek() == "|":
            self.pos += 1
            parts.append(self.parse_inter())
        return self.ctx.union(*parts)

    def parse_inter(self):
        parts = [self.parse_concat()]
        while self.peek() == "&":
            self.pos += 1
            parts.append(self.parse_concat())
        return self.ctx.inter(*parts)

    def parse_concat(self):
        parts = []
        while self.peek() and self.peek() not in "|&)":
            parts.append(self.parse_repeat())
        if not parts:
            self.error("empty expression (use '@' for the empty string)")
        return self.ctx.concat(*parts)

    def parse_repeat(self):
        if self.peek() == "~":
            self.pos += 1
            node = self.ctx.compl(self.parse_repeat())
        else:
            node = self.parse_atom()
        while self.peek() == "*":
            self.pos += 1
            node = self.ctx.star(node)
        return node

    def parse_atom(self):
        ch = self.next()
        if ch == "(":
            node = self.parse_union()
            if self.next() != ")":
                self.error("expected ')'")
            return node
        if ch == ".":
            return self.ctx.full_char
        if ch in "#∅":
            return self.ctx.empty
        if ch in "@ε":
            return self.ctx.eps
        if ch == "[":
            return self.parse_class()
        if ch == "\\":
            return self._char({self.next()})
        if ch in "|&)*~":
            self.error(f"unexpected character {ch!r}")
        return self._char({ch})

    def _char(self, chars):
        try:
            return self.ctx.char(chars)
        except ValueError as exc:
            self.error(str(exc))

    def parse_class(self):
        negate = False
        if self.peek() == "^":
            negate = True
            self.pos += 1
        chars = set()
        first = True
        while True:
            ch = self.peek()
            if not ch:
                self.error("unterminated character class")
            if ch == "]" and not first:
                self.pos += 1
                break
            first = False
            lo = self.next()
            if lo == "\\":
                lo = self.next()
            if self.peek() == "-" and self.pos + 1 < len(self.text) \
                    and self.text[self.pos + 1] != "]":
                self.pos += 1
                hi = self.next()
                if hi == "\\":
                    hi = self.next()
                if ord(hi) < ord(lo):
                    self.error(f"invalid range {lo!r}-{hi!r}")
                for code in range(ord(lo), ord(hi) + 1):
                    chars.add(chr(code))
            else:
                chars.add(lo)
        if negate:
            chars = set(self.ctx.alphabet_set) - chars
        return self._char(chars)


def parse(ctx, text):
    """把 pattern 解析为 Context 内唯一化的 AST。"""
    if not isinstance(text, str) or not text:
        raise ParseError("pattern must be a non-empty string")
    return _Parser(ctx, text).parse()
