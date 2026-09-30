"""posidx: positional inverted index with delete/replace semantics."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile

_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)

MANIFEST_NAME = "manifest.json"
INDEX_NAME = "index.json"
FORMAT_VERSION = 1


class QuerySyntaxError(ValueError):
    """Raised when a query string cannot be parsed."""


class CorruptIndexError(RuntimeError):
    """Raised when an on-disk index directory is missing or corrupted."""


def tokenize(text: str) -> list[str]:
    """Split text into lowercase alphanumeric tokens (Unicode aware).

    Positions are implied by list order: token i has position i.
    """
    return _TOKEN_RE.findall(text.lower())


# ---------------------------------------------------------------------------
# Query parsing / evaluation
# ---------------------------------------------------------------------------

_QTOKEN_RE = re.compile(
    r"""
    \s*(?:
        (?P<phrase>"(?:[^"\\]|\\.)*")   # "a b" phrase
      | (?P<lpar>\()
      | (?P<rpar>\))
      | (?P<word>[^\s()"]+)
    )
    """,
    re.VERBOSE,
)


class _Node:
    __slots__ = ()


class _Term(_Node):
    __slots__ = ("term",)

    def __init__(self, term: str):
        self.term = term


class _Phrase(_Node):
    __slots__ = ("terms",)

    def __init__(self, terms: list[str]):
        self.terms = terms


class _And(_Node):
    __slots__ = ("children",)

    def __init__(self, children: list[_Node]):
        self.children = children


class _Or(_Node):
    __slots__ = ("children",)

    def __init__(self, children: list[_Node]):
        self.children = children


class _Not(_Node):
    __slots__ = ("child",)

    def __init__(self, child: _Node):
        self.child = child


def _lex_query(query: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    pos = 0
    n = len(query)
    while pos < n:
        if query[pos].isspace():
            pos += 1
            continue
        m = _QTOKEN_RE.match(query, pos)
        if not m or m.end() == pos:
            raise QuerySyntaxError(f"unexpected character at offset {pos}")
        pos = m.end()
        if m.group("phrase") is not None:
            tokens.append(("PHRASE", m.group("phrase")))
        elif m.group("lpar") is not None:
            tokens.append(("LPAR", "("))
        elif m.group("rpar") is not None:
            tokens.append(("RPAR", ")"))
        else:
            tokens.append(("WORD", m.group("word")))
    return tokens


_KEYWORDS = {"AND", "OR", "NOT"}


class _Parser:
    def __init__(self, tokens: list[tuple[str, str]]):
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> tuple[str, str] | None:
        if self.pos < len(self.tokens):
            return self.tokens[self.pos]
        return None

    def next(self) -> tuple[str, str]:
        tok = self.peek()
        if tok is None:
            raise QuerySyntaxError("unexpected end of query")
        self.pos += 1
        return tok

    # expr := or_expr
    def parse(self) -> _Node:
        node = self.parse_or()
        if self.peek() is not None:
            raise QuerySyntaxError(f"unexpected token {self.peek()[1]!r}")
        return node

    # or_expr := and_expr (OR and_expr)*
    def parse_or(self) -> _Node:
        first = self.parse_and()
        children = [first]
        while self._at_keyword("OR"):
            self.next()
            children.append(self.parse_and())
        if len(children) == 1:
            return first
        return _Or(children)

    # and_expr := not_expr ((AND)? not_expr)*   (juxtaposition = AND)
    def parse_and(self) -> _Node:
        first = self.parse_not()
        children = [first]
        while True:
            tok = self.peek()
            if tok is None:
                break
            kind, value = tok
            if kind == "WORD" and value.upper() == "AND":
                self.next()
                children.append(self.parse_not())
            elif kind in ("PHRASE", "LPAR") or (
                kind == "WORD" and value.upper() not in ("OR",)
            ):
                children.append(self.parse_not())
            else:
                break
        if len(children) == 1:
            return first
        return _And(children)

    # not_expr := NOT not_expr | atom
    def parse_not(self) -> _Node:
        tok = self.peek()
        if tok is not None and tok[0] == "WORD" and tok[1].upper() == "NOT":
            self.next()
            return _Not(self.parse_not())
        return self.parse_atom()

    def parse_atom(self) -> _Node:
        kind, value = self.next()
        if kind == "LPAR":
            node = self.parse_or()
            closing = self.next()
            if closing[0] != "RPAR":
                raise QuerySyntaxError("expected ')'")
            return node
        if kind == "PHRASE":
            inner = value[1:-1].replace('\\"', '"').replace("\\\\", "\\")
            terms = tokenize(inner)
            if not terms:
                raise QuerySyntaxError("empty phrase")
            if len(terms) == 1:
                return _Term(terms[0])
            return _Phrase(terms)
        if kind == "WORD":
            if value.upper() in _KEYWORDS:
                raise QuerySyntaxError(f"unexpected operator {value!r}")
            terms = tokenize(value)
            if not terms:
                raise QuerySyntaxError(f"no searchable term in {value!r}")
            if len(terms) == 1:
                return _Term(terms[0])
            return _Phrase(terms)
        raise QuerySyntaxError(f"unexpected token {value!r}")

    def _at_keyword(self, kw: str) -> bool:
        tok = self.peek()
        return tok is not None and tok[0] == "WORD" and tok[1].upper() == kw


def parse_query(query: str) -> _Node:
    tokens = _lex_query(query)
    if not tokens:
        raise QuerySyntaxError("empty query")
    return _Parser(tokens).parse()


# ---------------------------------------------------------------------------
# Index
# ---------------------------------------------------------------------------


class PositionalIndex:
    """Positional inverted index supporting replace-on-reingest and delete."""

    def __init__(self) -> None:
        # term -> {doc_id: [positions]}
        self.postings: dict[str, dict[str, list[int]]] = {}
        # doc_id -> token list (source of truth for delete/replace)
        self.docs: dict[str, list[str]] = {}

    # -- mutation ---------------------------------------------------------

    def ingest(self, doc_id: str, text: str) -> None:
        if not isinstance(doc_id, str) or not isinstance(text, str):
            raise TypeError("doc_id and text must be str")
        self.delete(doc_id)  # replace semantics: drop any old version first
        tokens = tokenize(text)
        self.docs[doc_id] = tokens
        for position, term in enumerate(tokens):
            bucket = self.postings.setdefault(term, {})
            bucket.setdefault(doc_id, []).append(position)

    def delete(self, doc_id: str) -> bool:
        tokens = self.docs.pop(doc_id, None)
        if tokens is None:
            return False
        for term in set(tokens):
            bucket = self.postings.get(term)
            if bucket is None:
                continue
            bucket.pop(doc_id, None)
            if not bucket:
                del self.postings[term]
        return True

    # -- query ------------------------------------------------------------

    def query(self, query: str) -> list[str]:
        node = parse_query(query)
        universe = set(self.docs)
        result = self._eval(node, universe)
        return sorted(result)

    def _eval(self, node: _Node, universe: set[str]) -> set[str]:
        if isinstance(node, _Term):
            return set(self.postings.get(node.term, {}))
        if isinstance(node, _Phrase):
            return self._eval_phrase(node.terms)
        if isinstance(node, _And):
            sets = [self._eval(c, universe) for c in node.children]
            if not sets:
                return set()
            out = sets[0]
            for s in sets[1:]:
                out &= s
            return out
        if isinstance(node, _Or):
            out: set[str] = set()
            for c in node.children:
                out |= self._eval(c, universe)
            return out
        if isinstance(node, _Not):
            return universe - self._eval(node.child, universe)
        raise TypeError(f"unknown node {node!r}")

    def _eval_phrase(self, terms: list[str]) -> set[str]:
        posting_lists = [self.postings.get(t) for t in terms]
        if any(p is None for p in posting_lists):
            return set()
        candidates = set(posting_lists[0])
        for p in posting_lists[1:]:
            candidates &= set(p)
            if not candidates:
                return set()
        matched = set()
        for doc_id in candidates:
            first_positions = posting_lists[0][doc_id]
            rest = [p[doc_id] for p in posting_lists[1:]]
            for start in first_positions:
                if all((start + offset + 1) in rest[offset] for offset in range(len(rest))):
                    matched.add(doc_id)
                    break
        return matched

    # -- persistence ------------------------------------------------------

    def save(self, directory: str) -> None:
        os.makedirs(directory, exist_ok=True)
        payload = {
            "docs": self.docs,
            "postings": self.postings,
        }
        blob = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        digest = hashlib.sha256(blob).hexdigest()
        manifest = {
            "format": "posidx",
            "version": FORMAT_VERSION,
            "doc_count": len(self.docs),
            "index_file": INDEX_NAME,
            "index_sha256": digest,
        }
        manifest_blob = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
        _atomic_write(os.path.join(directory, INDEX_NAME), blob)
        _atomic_write(os.path.join(directory, MANIFEST_NAME), manifest_blob)

    @classmethod
    def load(cls, directory: str) -> "PositionalIndex":
        manifest_path = os.path.join(directory, MANIFEST_NAME)
        try:
            with open(manifest_path, "rb") as fh:
                manifest = json.loads(fh.read().decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CorruptIndexError(f"cannot read manifest: {exc}") from exc
        if (
            not isinstance(manifest, dict)
            or manifest.get("format") != "posidx"
            or manifest.get("version") != FORMAT_VERSION
            or not isinstance(manifest.get("index_sha256"), str)
        ):
            raise CorruptIndexError("manifest has invalid or unsupported fields")
        index_path = os.path.join(directory, manifest.get("index_file", INDEX_NAME))
        try:
            with open(index_path, "rb") as fh:
                blob = fh.read()
        except OSError as exc:
            raise CorruptIndexError(f"cannot read index file: {exc}") from exc
        if hashlib.sha256(blob).hexdigest() != manifest["index_sha256"]:
            raise CorruptIndexError("index file checksum mismatch")
        try:
            payload = json.loads(blob.decode("utf-8"))
            docs = payload["docs"]
            postings = payload["postings"]
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError) as exc:
            raise CorruptIndexError(f"index payload invalid: {exc}") from exc
        index = cls()
        index.docs = {str(k): list(v) for k, v in docs.items()}
        index.postings = {
            str(term): {str(doc): list(pos) for doc, pos in bucket.items()}
            for term, bucket in postings.items()
        }
        if manifest.get("doc_count") != len(index.docs):
            raise CorruptIndexError("manifest doc_count does not match index")
        return index


def _atomic_write(path: str, data: bytes) -> None:
    directory = os.path.dirname(path) or "."
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
