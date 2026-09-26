"""Workspace layout and component IO.

A workspace holds four derived components, each stored as one JSON file
under ``<root>/data``:

* ``docstore.json`` - document store manifest (doc_id -> file, sha256, num_tokens)
* ``lexicon.json``  - dictionary (term -> term_id, df, cf)
* ``index.json``    - inverted index (term_id -> sorted posting list)
* ``stats.json``    - collection statistics (num_docs, num_terms, total_tokens)

Every component carries a ``version`` field; components written by the
same build share the same version. The *fingerprint* is a SHA-256 over
the four component files and identifies an exact baseline.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

COMPONENTS = ("docstore", "lexicon", "index", "stats")


class Workspace:
    def __init__(self, root):
        self.root = Path(root)
        self.data_dir = self.root / "data"
        self.docs_dir = self.data_dir / "docs"

    def component_path(self, name: str) -> Path:
        if name not in COMPONENTS:
            raise ValueError(f"unknown component {name!r}")
        return self.data_dir / f"{name}.json"

    def load(self, name: str):
        path = self.component_path(name)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def save(self, name: str, payload) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
        self.component_path(name).write_text(text + "\n", encoding="utf-8")

    def fingerprint(self) -> str:
        """SHA-256 over the four component files, in a fixed order."""
        digest = hashlib.sha256()
        for name in COMPONENTS:
            path = self.component_path(name)
            digest.update(name.encode("utf-8"))
            digest.update(b"\0")
            digest.update(path.read_bytes() if path.exists() else b"<missing>")
            digest.update(b"\0")
        return digest.hexdigest()

    def common_version(self):
        """The shared version of all four components, or None if absent/skewed."""
        versions = set()
        for name in COMPONENTS:
            payload = self.load(name)
            if payload is None:
                return None
            versions.add(payload.get("version"))
        if len(versions) != 1:
            return None
        return versions.pop()
