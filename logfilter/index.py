"""Inverted index over a compressed dictionary automaton.

Documents are tokenized on whitespace after normalization.  The dictionary
is a RadixTree mapping each distinct term to its postings; postings map
doc_id -> occurrence count.  Deleting a document decrements the postings,
and a term whose last reference disappears is removed from the compressed
automaton (merging nodes) so all counts stay in sync.
"""

from __future__ import annotations

import json
import os
from collections import Counter

from .normalize import NormalizationRules
from .radix import RadixTree

INDEX_FORMAT = "logfilter-index/1"


class VersionMismatchError(ValueError):
    pass


class Index:
    def __init__(self, rules: NormalizationRules | None = None):
        self.rules = rules or NormalizationRules()
        self.dictionary = RadixTree()
        self.postings: dict[str, dict[str, int]] = {}
        self.docs: dict[str, dict] = {}

    # -- mutation ---------------------------------------------------------

    def tokenize(self, text: str) -> list[str]:
        return self.rules.normalize(text).split()

    def add_document(self, doc_id: str, text: str) -> dict:
        """Add or replace a document.  Returns its term counts."""
        if doc_id in self.docs:
            self.delete_document(doc_id)
        counts = Counter(self.tokenize(text))
        for term, count in counts.items():
            self.dictionary.add(term)
            self.postings.setdefault(term, {})[doc_id] = count
        self.docs[doc_id] = {"text": text, "terms": dict(counts)}
        return dict(counts)

    def delete_document(self, doc_id: str) -> bool:
        entry = self.docs.pop(doc_id, None)
        if entry is None:
            return False
        for term in entry["terms"]:
            term_postings = self.postings[term]
            del term_postings[doc_id]
            if not term_postings:
                # last reference gone: drop the term and compress the automaton
                del self.postings[term]
                self.dictionary.remove(term)
        return True

    # -- queries ----------------------------------------------------------

    def postings_for(self, term: str) -> dict[str, int]:
        return self.postings.get(term, {})

    def stats(self) -> dict:
        return {
            "rules_version": self.rules.version,
            "documents": len(self.docs),
            "distinct_terms": self.dictionary.size,
            "postings": sum(len(p) for p in self.postings.values()),
            "tokens": sum(sum(e["terms"].values()) for e in self.docs.values()),
        }

    # -- persistence ------------------------------------------------------

    def to_dict(self) -> dict:
        return {
            "format": INDEX_FORMAT,
            "rules_version": self.rules.version,
            "docs": self.docs,
            "postings": self.postings,
        }

    @classmethod
    def from_dict(cls, data: dict, rules: NormalizationRules | None = None) -> "Index":
        if data.get("format") != INDEX_FORMAT:
            raise ValueError(f"unsupported index format: {data.get('format')!r}")
        stored = data.get("rules_version")
        if rules is not None and rules.version != stored:
            raise VersionMismatchError(
                f"index uses normalization {stored!r}, requested {rules.version!r}"
            )
        index = cls(NormalizationRules(stored))
        index.docs = {doc_id: dict(entry) for doc_id, entry in data["docs"].items()}
        index.postings = {
            term: dict(posts) for term, posts in data["postings"].items()
        }
        for term in index.postings:
            index.dictionary.add(term)
        return index

    def save(self, path: str) -> None:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.to_dict(), fh, ensure_ascii=False, sort_keys=True)
        os.replace(tmp, path)

    @classmethod
    def load(cls, path: str, rules: NormalizationRules | None = None) -> "Index":
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return cls.from_dict(data, rules)
