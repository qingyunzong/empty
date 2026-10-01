"""Document model: field flattening, tokenization, paragraphs and spans.

A JSON document is flattened into a list of *field instances*.  Each leaf
scalar value becomes one instance addressed by a dotted path.  Elements of a
JSON array become *separate* instances sharing the same path (distinguished by
an ordinal), which is what makes same-name array fields work without ever
mixing tokens across values.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

TOKEN_RE = re.compile(r"\w+", re.UNICODE)
PARA_RE = re.compile(r"\n\s*\n")


@dataclass(frozen=True)
class Token:
    text: str   # normalized (lowercase) token text
    pos: int    # token position inside the field instance
    para: int   # paragraph index inside the field instance
    start: int  # char offset of the token in the original field text
    end: int    # char offset (exclusive) in the original field text


@dataclass(frozen=True)
class FieldInstance:
    path: str      # dotted field path, e.g. "items.name"
    ordinal: int   # which instance of this path inside the document
    text: str      # original text of the value


@dataclass(frozen=True)
class Posting:
    field_path: str
    instance: int   # FieldInstance.ordinal
    para: int
    pos: int
    start: int      # char offset in the original field text
    end: int


def paragraph_spans(text: str) -> list[tuple[int, int]]:
    """Char spans of paragraphs (separated by blank lines)."""
    spans = []
    start = 0
    for m in PARA_RE.finditer(text):
        spans.append((start, m.start()))
        start = m.end()
    spans.append((start, len(text)))
    return spans


def tokenize(text: str) -> list[Token]:
    """Tokenize text, tracking token position, paragraph and char span."""
    tokens: list[Token] = []
    pos = 0
    for para, (pstart, pend) in enumerate(paragraph_spans(text)):
        for m in TOKEN_RE.finditer(text, pstart, pend):
            tokens.append(Token(m.group(0).lower(), pos, para, m.start(), m.end()))
            pos += 1
    return tokens


def flatten(doc: dict) -> list[FieldInstance]:
    """Flatten a JSON document into field instances.

    - dicts extend the path with their key;
    - lists produce one instance per element under the *same* path;
    - ``None`` produces an empty-text instance (the field exists but has no
      tokens), other scalars are stringified.
    """
    instances: list[FieldInstance] = []
    counts: dict[str, int] = {}

    def add(path: str, text: str) -> None:
        ordinal = counts.get(path, 0)
        counts[path] = ordinal + 1
        instances.append(FieldInstance(path, ordinal, text))

    def walk(value, path: tuple[str, ...]) -> None:
        if isinstance(value, dict):
            for key, val in value.items():
                walk(val, path + (str(key),))
        elif isinstance(value, list):
            for item in value:
                walk(item, path)
        elif value is None:
            if path:
                add(".".join(path), "")
        elif isinstance(value, str):
            add(".".join(path), value)
        else:
            add(".".join(path), str(value))

    walk(doc, ())
    return instances


def spec_matches(spec: str, path: str) -> bool:
    """Match a field spec against a concrete field path.

    ``*`` matches exactly one path segment, except as the final segment where
    it matches one or more remaining segments (so ``meta.*`` covers
    ``meta.author`` and ``meta.author.name``).
    """
    return _match_segments(spec.split("."), path.split("."))


def _match_segments(spec: list[str], path: list[str]) -> bool:
    if not spec:
        return not path
    head = spec[0]
    if head == "*":
        if len(spec) == 1:
            return len(path) >= 1
        return len(path) >= 1 and _match_segments(spec[1:], path[1:])
    if not path or head != path[0]:
        return False
    return _match_segments(spec[1:], path[1:])
