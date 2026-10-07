"""Inverted index over normalized terms plus its compressed automaton."""

from __future__ import annotations

from .fst import Automaton
from .normalize import CURRENT_NORMALIZATION_VERSION, normalize


class Index:
    """term -> sorted posting list of doc ids, with a DAFSA over terms.

    Deleting a document removes it from every posting; a term whose last
    reference disappears is dropped, which synchronously updates the term
    count and (lazily, on next access) the compressed automaton nodes.
    `generation` increments on every effective mutation and is used to
    detect stale search cursors.
    """

    def __init__(self, normalization_version=CURRENT_NORMALIZATION_VERSION):
        self.normalization_version = normalization_version
        self.generation = 0
        self.docs = {}      # doc_id -> [normalized term, ...] (unique, ordered)
        self.postings = {}  # term -> sorted [doc_id, ...]
        self._automaton = None
        self._dirty = True

    @property
    def num_docs(self):
        return len(self.docs)

    @property
    def num_terms(self):
        return len(self.postings)

    def add_document(self, doc_id, terms):
        doc_id = str(doc_id)
        normed = []
        seen = set()
        for term in terms:
            nt = normalize(term, self.normalization_version)
            if nt and nt not in seen:
                seen.add(nt)
                normed.append(nt)
        if doc_id in self.docs:
            self._remove(doc_id)
        self.docs[doc_id] = normed
        for term in normed:
            bucket = self.postings.setdefault(term, [])
            bucket.append(doc_id)
            bucket.sort()
        self.generation += 1
        self._dirty = True

    def delete_document(self, doc_id):
        doc_id = str(doc_id)
        if doc_id not in self.docs:
            return False
        self._remove(doc_id)
        return True

    def _remove(self, doc_id):
        for term in self.docs.pop(doc_id):
            bucket = self.postings[term]
            bucket.remove(doc_id)
            if not bucket:
                del self.postings[term]
        self.generation += 1
        self._dirty = True

    @property
    def automaton(self):
        if self._dirty or self._automaton is None:
            self._automaton = Automaton(self.postings.keys())
            self._dirty = False
        return self._automaton

    def to_dict(self):
        return {
            "normalization_version": self.normalization_version,
            "generation": self.generation,
            "docs": self.docs,
        }

    @classmethod
    def from_dict(cls, data):
        index = cls(normalization_version=data["normalization_version"])
        for doc_id, terms in data["docs"].items():
            index.add_document(doc_id, terms)
        index.generation = data["generation"]
        return index
