"""Storage layout and (de)serialization for the four tables."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

DOCSTORE = "docstore.json"
LEXICON = "lexicon.json"
INDEX = "inverted_index.json"
STATS = "stats.json"
DOCS_DIR = "docs"


def load_json(root: Path, name: str):
    return json.loads((root / name).read_text(encoding="utf-8"))


def save_json(root: Path, name: str, obj) -> None:
    payload = json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True)
    (root / name).write_text(payload + "\n", encoding="utf-8")


@dataclass
class Dataset:
    root: Path
    docstore: dict
    lexicon: dict
    index: dict
    stats: dict

    @classmethod
    def load(cls, root) -> "Dataset":
        root = Path(root)
        return cls(
            root=root,
            docstore=load_json(root, DOCSTORE),
            lexicon=load_json(root, LEXICON),
            index=load_json(root, INDEX),
            stats=load_json(root, STATS),
        )

    def save(self) -> None:
        save_json(self.root, DOCSTORE, self.docstore)
        save_json(self.root, LEXICON, self.lexicon)
        save_json(self.root, INDEX, self.index)
        save_json(self.root, STATS, self.stats)
