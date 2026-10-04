# logfilter

Exact log search with wildcards and bounded edit distance, built on a
compressed dictionary automaton (radix tree) intersected with a pattern
automaton, plus an inverted index for document results.  Pure Python 3.11
standard library; tests use `unittest`.

## Pattern language

Matching is over Unicode code points.  Document tokens and literal pattern
characters are normalized with fixed, versioned rules (default
`nfc-casefold-v1`: NFKC + casefold); every index records its rule version
and refuses to operate under a different one.

| Syntax   | Meaning                                                     |
|----------|-------------------------------------------------------------|
| `abc`    | literal code points                                         |
| `?`      | exactly one code point                                      |
| `*`      | any sequence of code points, including the empty string     |
| `[abc]`  | character class; ranges `[a-z]`; negate with `[!ab]`/`[^ab]`|
| `\x`     | escaped literal (e.g. `\*`, `\~`, `\\`)                     |
| `~d`     | suffix: allow up to `d` edits, `d` in 0..2 (`~` alone = 1)  |

A word matches iff some string accepted by the wildcard part of the
pattern is within `d` Levenshtein edits of the word.  Malformed patterns
(unterminated class, reversed range, `~3`, stray `~`, dangling escape, ...)
raise `PatternError` before any index or search state is touched —
rejection is atomic.

## How it works

- **Compressed dictionary automaton** (`logfilter/radix.py`): a radix tree
  whose edges carry string labels; shared prefixes are stored once.
  Insertion splits edges, deletion of a term's last reference merges
  single-child chains back together.
- **On-demand intersection** (`logfilter/search.py`): the search explores
  the product graph *dictionary position × pattern-NFA state* best-first
  by edit cost (Dijkstra).  Words are never expanded up front; the
  automaton is walked edge by edge as the frontier demands.  Transitions:
  match/substitute (0/1), delete word char (1), insert pattern token (1),
  star consumes a char (0).
- **Inverted index** (`logfilter/index.py`): term → `{doc_id: count}`.
  Document results are deduplicated per term; deleting a document
  decrements postings and removes terms (compressing nodes) when their
  last reference disappears.  All counts stay in sync.
- **Pagination / budget / resume**: `search(..., limit=, budget=, cursor=)`.
  A result is `complete` only when the frontier is fully explored; an
  incomplete result always carries a serializable cursor.  Every frontier
  entry's accumulated cost is a lower bound on the edits of any completion
  through it, exposed as `stats.frontier_lower_bound`.
- **Alignment evidence** (`logfilter/alignment.py`): every hit carries the
  actual minimum-cost edit script (`match`/`wildcard`/`star`/`substitute`/
  `delete`/`insert` ops) proving its edit count.
- **Independent verification** (`logfilter/verify.py`): a separate
  token-index DP (`min_edits`) and a recursive wildcard interpreter
  (`wildcard_match`) share no code with the engine; the test suite
  cross-checks them on exhaustive short-alphabet dictionaries.

## Library usage

```python
from logfilter import Index, parse_pattern, search

index = Index()
index.add_document("d1", "ERROR: disk failed")
index.add_document("d2", "error: disk flaky")

result = search(index, parse_pattern("error~1"), limit=10)
for hit in result["results"]:
    print(hit["word"], hit["edits"], hit["docs"], hit["alignment"])
if not result["complete"]:
    page2 = search(index, parse_pattern("error~1"), limit=10,
                   cursor=result["cursor"])
```

## JSON CLI

```
python3.11 -m logfilter INDEX add DOC_ID TEXT...
python3.11 -m logfilter INDEX delete DOC_ID
python3.11 -m logfilter INDEX search PATTERN [--limit N] [--budget N] [--cursor JSON]
python3.11 -m logfilter INDEX stats
python3.11 -m logfilter INDEX --rules identity-v0 add DOC_ID TEXT...
```

All output is a single JSON object on stdout; exit code 0 on success, 2 on
error (reported as JSON, index file untouched).  `search` output includes
`complete`, `results` (with alignment evidence), deduplicated `documents`,
a resume `cursor` when incomplete, and `stats.frontier_lower_bound`.

## Tests

```
python3.11 -m unittest discover -s tests -v
```

Covers: star matching the empty string, character-class endpoints, the
same word in different documents (dedup), compressed-node split/merge,
normalization version changes, pagination/budget resume, atomic rejection
of illegal patterns, alignment evidence, and an exhaustive cross-check of
the automaton engine against the independent DP/wildcard interpreter over
all words of length 1..5 on the alphabet `{a,b}`.

## Test run record

Command: `python3.11 -m unittest discover -s tests -v`
Result (2026-10-04, Python 3.11.16): **66 tests, 0 failures, 0 errors — OK**
(~3.3s; includes the exhaustive `{a,b}` cross-check and CLI subprocess tests.)
