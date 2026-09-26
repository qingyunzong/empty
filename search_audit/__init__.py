"""Read-only consistency auditor for a miniature search-index dataset.

The dataset consists of four tables plus raw UTF-8 documents:

- lexicon        (lexicon.json)        term -> {term_id, df}
- inverted index (inverted_index.json) term -> sorted unique [doc_id]
- document store (docstore.json)       doc_id -> {path, length}
- statistics     (stats.json)          num_docs / num_terms / total_tokens

Everything is plain JSON + local UTF-8 text files.  No search service and
no full-text library is used anywhere.
"""

__version__ = "1.0.0"
