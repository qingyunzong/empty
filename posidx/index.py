"""Positional inverted index with replacement-safe deletes and persistence."""

from __future__ import annotations

import json
import os
import re

_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)

MANIFEST_NAME = "manifest.json"
DOCS_NAME = "docs.json"
FORMAT_NAME = "posidx"
FORMAT_VERSION = 1


class IndexCorruptError(Exception):
    """Raised when an on-disk index directory is missing or malformed."""


def tokenize(text: str) -> list[str]:
    """Split *text* into tokens.

    Tokens are maximal runs of Unicode alphanumeric characters, lowercased.
    Positions count tokens only, starting at 0.
    """
    return [m.group(0) for m in _TOKEN_RE.finditer(text.lower())]


class PositionalIndex:
    """A positional inverted index: term -> {doc_id: [positions]}.

    Re-ingesting an existing id atomically replaces the old version, and
    ``delete`` removes every posting contributed by the document, so deleted
    or superseded text can never match.
    """

    def __init__(self) -> None:
        self._docs: dict[str, list[str]] = {}
        self._postings: dict[str, dict[str, list[int]]] = {}

    def __len__(self) -> int:
        return len(self._docs)

    def __contains__(self, doc_id: str) -> bool:
        return doc_id in self._docs

    def doc_ids(self) -> set[str]:
        return set(self._docs)

    def tokens_of(self, doc_id: str) -> list[str]:
        return list(self._docs[doc_id])

    def postings(self, term: str) -> dict[str, list[int]]:
        """Return {doc_id: [positions]} for *term* (empty dict if absent)."""
        return self._postings.get(term, {})

    def ingest(self, doc_id: str, text: str) -> None:
        """Add a document; an existing id is fully replaced first."""
        if not isinstance(doc_id, str) or not isinstance(text, str):
            raise TypeError("doc_id and text must be str")
        if doc_id in self._docs:
            self.delete(doc_id)
        tokens = tokenize(text)
        self._docs[doc_id] = tokens
        for pos, tok in enumerate(tokens):
            bucket = self._postings.setdefault(tok, {})
            bucket.setdefault(doc_id, []).append(pos)

    def delete(self, doc_id: str) -> bool:
        """Remove *doc_id*; no-op (returns False) if it is not present."""
        tokens = self._docs.pop(doc_id, None)
        if tokens is None:
            return False
        for tok in tokens:
            bucket = self._postings.get(tok)
            if bucket is None:
                continue
            bucket.pop(doc_id, None)
            if not bucket:
                del self._postings[tok]
        return True

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------
    def save(self, directory: str) -> None:
        """Persist the index into *directory* (created if needed).

        ``docs.json`` is written first and ``manifest.json`` last, so the
        manifest acts as a commit marker for a complete save.
        """
        os.makedirs(directory, exist_ok=True)
        docs_payload = {"docs": self._docs}
        manifest = {
            "format": FORMAT_NAME,
            "version": FORMAT_VERSION,
            "doc_count": len(self._docs),
        }
        self._atomic_write(os.path.join(directory, DOCS_NAME), docs_payload)
        self._atomic_write(os.path.join(directory, MANIFEST_NAME), manifest)

    @staticmethod
    def _atomic_write(path: str, payload: dict) -> None:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
        os.replace(tmp, path)

    @classmethod
    def load(cls, directory: str) -> "PositionalIndex":
        """Load an index previously stored with :meth:`save`.

        Raises :class:`IndexCorruptError` if the directory does not contain
        a valid, complete index.
        """
        manifest_path = os.path.join(directory, MANIFEST_NAME)
        docs_path = os.path.join(directory, DOCS_NAME)
        try:
            with open(manifest_path, "r", encoding="utf-8") as fh:
                manifest = json.load(fh)
        except (OSError, ValueError) as exc:
            raise IndexCorruptError(
                f"cannot read manifest {manifest_path}: {exc}"
            ) from exc
        if (
            not isinstance(manifest, dict)
            or manifest.get("format") != FORMAT_NAME
            or manifest.get("version") != FORMAT_VERSION
        ):
            raise IndexCorruptError(f"unsupported manifest in {directory}")
        try:
            with open(docs_path, "r", encoding="utf-8") as fh:
                payload = json.load(fh)
        except (OSError, ValueError) as exc:
            raise IndexCorruptError(
                f"cannot read docs {docs_path}: {exc}"
            ) from exc
        docs = payload.get("docs") if isinstance(payload, dict) else None
        if not isinstance(docs, dict) or not all(
            isinstance(k, str)
            and isinstance(v, list)
            and all(isinstance(t, str) for t in v)
            for k, v in docs.items()
        ):
            raise IndexCorruptError(f"malformed docs payload in {docs_path}")
        if isinstance(manifest.get("doc_count"), int) and manifest[
            "doc_count"
        ] != len(docs):
            raise IndexCorruptError(
                f"doc_count mismatch in {directory}: manifest says "
                f"{manifest['doc_count']}, docs.json has {len(docs)}"
            )
        index = cls()
        # Rebuild postings from the stored token streams so the in-memory
        # structures are guaranteed consistent with what was saved.
        for doc_id, tokens in docs.items():
            index._docs[doc_id] = tokens
            for pos, tok in enumerate(tokens):
                bucket = index._postings.setdefault(tok, {})
                bucket.setdefault(doc_id, []).append(pos)
        return index
