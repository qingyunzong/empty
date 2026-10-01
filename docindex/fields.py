"""Field paths, wildcard field patterns and alias rules.

Documents are nested JSON-like structures.  Every string leaf is a *field
instance* addressed by a path such as ``title``, ``meta.author.name`` or
``tags[0]``.  Arrays therefore produce several instances of the "same" field
(e.g. ``tags[0]``, ``tags[1]``), which is what allows phrase constraints to
be scoped to a single instance.

Field patterns used in queries support two wildcards:

* ``*``   -- matches exactly one name segment (``*.name``)
* ``[*]`` -- matches exactly one array index (``tags[*]``)

Dict keys must not contain ``.``, ``[`` or ``]``.
"""
from __future__ import annotations

import re

from .errors import AliasError, FieldPathError

_NAME_RE = r"[^\.\[\]]+"
_PART_RE = re.compile(r"^([^\[\]]*)((?:\[\d+\])*)$")
_PATTERN_PART_RE = re.compile(r"^([^\[\]]*)((?:\[\d+\]|\[\*\])*)$")
_INDEX_RE = re.compile(r"\[(\d+)\]")
_PATTERN_INDEX_RE = re.compile(r"\[(\d+|\*)\]")


def parse_path(path: str) -> tuple:
    """Parse ``a.b[0].c`` into ``("a", "b", 0, "c")``."""
    if not isinstance(path, str) or not path:
        raise FieldPathError(f"invalid field path: {path!r}")
    segments: list = []
    for part in path.split("."):
        match = _PART_RE.match(part)
        if not match or (not match.group(1) and not match.group(2)):
            raise FieldPathError(f"invalid field path: {path!r}")
        if match.group(1):
            segments.append(match.group(1))
        for index in _INDEX_RE.findall(match.group(2) or ""):
            segments.append(int(index))
    if not segments:
        raise FieldPathError(f"invalid field path: {path!r}")
    return tuple(segments)


def format_path(segments) -> str:
    """Inverse of :func:`parse_path`."""
    out = ""
    for seg in segments:
        if isinstance(seg, int):
            out += f"[{seg}]"
        else:
            out += ("." if out else "") + seg
    return out


def iter_field_instances(doc, segments=()):
    """Yield ``(path_string, text)`` for every string leaf in *doc*."""
    if isinstance(doc, dict):
        for key, value in doc.items():
            yield from iter_field_instances(value, segments + (key,))
    elif isinstance(doc, list):
        for index, value in enumerate(doc):
            yield from iter_field_instances(value, segments + (index,))
    elif isinstance(doc, str):
        yield format_path(segments), doc


def get_path(doc, segments):
    node = doc
    for seg in segments:
        if isinstance(seg, int):
            if not isinstance(node, list) or seg >= len(node) or seg < 0:
                raise FieldPathError(f"no such field: {format_path(segments)}")
            node = node[seg]
        else:
            if not isinstance(node, dict) or seg not in node:
                raise FieldPathError(f"no such field: {format_path(segments)}")
            node = node[seg]
    return node


def set_path(doc, segments, value, create=True):
    """Set ``doc`` at *segments*, creating intermediate dicts if allowed."""
    node = doc
    for i, seg in enumerate(segments[:-1]):
        nxt = segments[i + 1]
        if isinstance(seg, int):
            if not isinstance(node, list):
                raise FieldPathError(f"not an array at segment {seg!r} of {format_path(segments)}")
            if seg >= len(node):
                if not create:
                    raise FieldPathError(f"no such field: {format_path(segments)}")
                while len(node) <= seg:
                    node.append([] if isinstance(nxt, int) else {})
            node = node[seg]
        else:
            if not isinstance(node, dict):
                raise FieldPathError(f"not an object at segment {seg!r} of {format_path(segments)}")
            if seg not in node:
                if not create:
                    raise FieldPathError(f"no such field: {format_path(segments)}")
                node[seg] = [] if isinstance(nxt, int) else {}
            node = node[seg]
    last = segments[-1]
    if isinstance(last, int):
        if not isinstance(node, list):
            raise FieldPathError(f"not an array at {format_path(segments)}")
        if last == len(node):
            node.append(value)
        elif 0 <= last < len(node):
            node[last] = value
        else:
            raise FieldPathError(f"array index out of range: {format_path(segments)}")
    else:
        if not isinstance(node, dict):
            raise FieldPathError(f"not an object at {format_path(segments)}")
        node[last] = value


def delete_path(doc, segments):
    parent = get_path(doc, segments[:-1]) if len(segments) > 1 else doc
    last = segments[-1]
    if isinstance(last, int):
        if not isinstance(parent, list) or last >= len(parent):
            raise FieldPathError(f"no such field: {format_path(segments)}")
        parent.pop(last)
    else:
        if not isinstance(parent, dict) or last not in parent:
            raise FieldPathError(f"no such field: {format_path(segments)}")
        del parent[last]


def move_path(doc, src_segments, dst_segments):
    """Move the value at *src_segments* to *dst_segments*."""
    if src_segments == dst_segments:
        raise FieldPathError("source and destination are identical")
    if dst_segments[: len(src_segments)] == src_segments:
        raise FieldPathError("cannot move a field into itself")
    value = get_path(doc, src_segments)
    delete_path(doc, src_segments)
    set_path(doc, dst_segments, value)


def compile_pattern(pattern: str) -> re.Pattern:
    """Compile a field pattern (with ``*`` / ``[*]`` wildcards) to a regex."""
    if not isinstance(pattern, str) or not pattern:
        raise FieldPathError(f"invalid field pattern: {pattern!r}")
    out: list[str] = []
    for part in pattern.split("."):
        match = _PATTERN_PART_RE.match(part)
        if not match or (not match.group(1) and not match.group(2)):
            raise FieldPathError(f"invalid field pattern: {pattern!r}")
        name, indexes = match.group(1), match.group(2) or ""
        if name:
            if out:
                out.append(re.escape("."))
            out.append(_NAME_RE if name == "*" else re.escape(name))
        for idx in _PATTERN_INDEX_RE.findall(indexes):
            out.append(r"\[\d+\]" if idx == "*" else re.escape(f"[{idx}]"))
    return re.compile("^" + "".join(out) + "$")


class FieldMatcher:
    """Matches field instance paths against a list of patterns.

    ``patterns=None`` means "all fields" (an unrestricted query term).
    """

    def __init__(self, patterns):
        self.patterns = list(patterns) if patterns is not None else None
        self._regexes = [compile_pattern(p) for p in self.patterns] if self.patterns is not None else None

    def match(self, field_path: str) -> bool:
        if self._regexes is None:
            return True
        return any(regex.match(field_path) for regex in self._regexes)

    def __repr__(self):  # pragma: no cover - debugging aid
        return f"FieldMatcher({self.patterns!r})"


class AliasRules:
    """Field alias rules with versioning and cycle detection.

    ``rules`` maps an alias name to a list of targets; a target may itself be
    an alias (chains are resolved transitively).  Every successful
    :meth:`set_rules` call bumps :attr:`version`, which is part of the
    candidate-cache key and therefore invalidates cached candidates.
    """

    def __init__(self, rules=None):
        self.rules: dict[str, list[str]] = {k: list(v) for k, v in (rules or {}).items()}
        self.version = 0

    def set_rules(self, rules) -> None:
        new_rules = {str(k): [str(t) for t in v] for k, v in (rules or {}).items()}
        for name in new_rules:
            self._resolve(name, new_rules, ())  # validate before committing
        self.rules = new_rules
        self.version += 1

    def resolve(self, name: str) -> list[str]:
        """Resolve *name* to a sorted list of concrete field patterns."""
        return sorted(self._resolve(name, self.rules, ()))

    @staticmethod
    def _resolve(name, rules, seen) -> set:
        if name in seen:
            cycle = " -> ".join(list(seen) + [name])
            raise AliasError(f"field alias cycle detected: {cycle}")
        if name not in rules:
            return {name}
        resolved: set = set()
        for target in rules[name]:
            resolved |= AliasRules._resolve(target, rules, seen + (name,))
        return resolved
