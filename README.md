# logfilter

Log-term filtering with wildcards and bounded edit distance over a
compressed dictionary automaton (minimal acyclic DFA / DAFSA) plus an
inverted index.  Python 3.11, standard library only.

## Pattern language

Matching is performed on **Unicode code points** of normalized terms
(see "Normalization" below).

| Syntax   | Meaning                                                     |
|----------|-------------------------------------------------------------|
| `*`      | any sequence of code points, **including the empty string** |
| `?`      | exactly one code point                                      |
| `[abc]`  | one code point from the set                                 |
| `[a-z]`  | inclusive code-point range (both endpoints match)           |
| `[^abc]` | negated class                                               |
| `\x`     | literal `x` (escape)                                        |
| `{~d}`   | trailing edit-distance marker, `d` in 0..2 (`{~}` = `{~1}`) |

Invalid patterns (unterminated class, out-of-order range, `d > 2`,
dangling escape, misplaced `{~`) raise `PatternError` before any state
is touched — rejection is atomic.

## How matching works

- The dictionary of normalized terms is stored as a **minimal acyclic
  DFA**: shared prefixes *and* suffixes are merged into single nodes.
- The pattern is interpreted as a weighted automaton with states
  `(position, errors)`.  It is intersected with the dictionary automaton
  **on demand** by a DFS over product states `(dfa_node, pos, errors,
  prefix)` — dictionary words are never expanded and matched one by one.
- Every accepted term is assigned its **true minimal edit distance** and
  a concrete **edit alignment** (match / substitute / insert / delete /
  star operations) computed by a small DP that runs only for hits.
- `logfilter.bruteforce` is an independent recursive-DP matcher used by
  the test-suite to cross-check the automaton on small short-alphabet
  dictionaries.

## Index semantics

- `Index.add_document(doc_id, terms)` normalizes and dedups terms per
  document; re-adding a document replaces it.
- `Index.delete_document(doc_id)` removes the document from all
  postings; a term whose **last reference** disappears is dropped, which
  synchronously updates `num_terms` and the compressed automaton nodes
  (node splits/merges are covered by tests).
- Multiple candidate terms matching in the same document produce a
  **single** document result listing all matching terms.
- Every mutation bumps `index.generation`; cursors are bound to it.

## Pagination, budget, resume

`search(index, pattern=..., d=..., limit=..., budget=...)` returns a
`SearchResult`:

- `limit` caps the number of documents per page (a page may be exceeded
  only by the postings of one final term).
- `budget` caps the number of product-state expansions per call.
- `complete` is `True` **only** when the frontier is fully explored;
  incomplete results always carry a `cursor` and a `frontier` where each
  entry keeps `distance_lower_bound` (errors accumulated so far — a valid
  lower bound for any hit reachable only through that entry).
- Resume with `search(index, cursor=cursor)`.  Cursors are plain JSON
  objects; mutating the index invalidates them (`CursorError`).

## Normalization

Rules are fixed and versioned: `nfc-casefold-v1` = NFC + casefold,
applied to terms and pattern literals alike.  An index records the
version it was built with; searching it with a library whose
`CURRENT_NORMALIZATION_VERSION` differs raises
`NormalizationVersionError` (rebuild required).

## Library usage

```python
from logfilter import Index, search

index = Index()
index.add_document("log1", ["error", "timeout", "retry"])
index.add_document("log2", ["Error", "connection"])

result = search(index, pattern="err?r{~1}", limit=10)
for entry in result.results:
    for hit in entry["terms"]:
        print(entry["doc_id"], hit["term"], hit["distance"], hit["alignment"])
```

## JSON CLI

```
python3.11 -m logfilter --store STORE add     < {"doc_id": "1", "text": "hello world"}
python3.11 -m logfilter --store STORE add     < {"doc_id": "2", "terms": ["help", "hell"]}
python3.11 -m logfilter --store STORE delete  < {"doc_id": "1"}
python3.11 -m logfilter --store STORE search  < {"pattern": "hel*{~1}", "limit": 10, "budget": 1000}
python3.11 -m logfilter --store STORE search  < {"cursor": <cursor from previous response>}
python3.11 -m logfilter --store STORE stats   < {}
```

Input and output are JSON on stdin/stdout.  Exit codes: `0` ok,
`2` invalid pattern / stale cursor / normalization-version mismatch,
`1` other errors.  `search` never writes the store, so a rejected
pattern leaves it byte-identical.

## Tests

```
python3.11 -m unittest discover -s tests -v
```

Last recorded run on this machine (Python 3.11.16): **53 tests, OK**
(1.4 s).  Coverage includes: star matching the empty string, character
class endpoints, the same word in different documents, compressed-node
split/merge on add/delete, normalization version change detection,
pagination/resume against a full scan, atomic rejection of invalid
patterns, and a randomized cross-check of the automaton against an
independent DP matcher on short-alphabet dictionaries with alignment
evidence validation.
