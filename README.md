# docindex

Multi-field positional document retrieval in pure Python 3.11 (standard
library only). Documents are nested JSON objects; every string leaf is a
searchable **field instance** addressed by a path such as `title`,
`meta.author.name` or `tags[0]`.

## Features

- **Positional index** — every token is stored with its field path, paragraph
  and original character span, so every hit carries locateable evidence
  (`field`, `paragraph`, `span`, `text`).
- **Query language** — field qualification, phrases, `AND` / `OR` / `NOT`,
  proximity (`NEAR/k`) and nested parentheses.
- **Phrase safety** — positions are scoped per field instance and paragraphs
  are separated by a large position gap, so a phrase can never be assembled
  from tokens of different fields, different array elements or different
  paragraphs.
- **Typed dataflow** — queries compile to an operator tree whose results are
  either `PositionalResult` (docs + occurrences) or `BooleanResult` (doc set
  only). The two kinds are never mixed: combining a positional branch with a
  boolean one (`NOT`, `*`, `field:*`) yields a boolean result.
- **Universe `NOT`** — `NOT q` means *all documents in the queried view
  (live index or snapshot) minus the documents matching `q`*. Documents with
  empty or missing fields are therefore matched by `NOT field:term`.
- **Field wildcards & aliases** — `tags[*]` and `*.name` patterns; an alias
  maps one name to several fields (chains allowed, cycles rejected). A
  wildcard phrase must complete inside one legal field instance.
- **Atomic batches** — `add_doc` / `delete_doc` / `set_field` / `delete_field`
  / `move_field` (nested paths) are validated and applied copy-on-write; any
  failure rolls the whole batch back. Index and statistics are swapped in
  together with a bumped `index_version`.
- **Snapshots** — named frozen views (documents + alias rules) that can be
  queried independently of later mutations.
- **Candidate cache** — keyed by `(query, alias_version, index_version,
  view)`; changing alias rules bumps the rule version and invalidates cached
  candidates.
- **Persistence** — `Index.save(path)` / `Index.restore(path)` (JSON).
- **Cross-checking** — `docindex.verify` is an independent per-document
  interpreter (no inverted index) used to verify index results and evidence.

## Query language

```
query    := or_expr
or_expr  := and_expr (OR and_expr)*
and_expr := unary (AND? unary)*          # juxtaposition = AND
unary    := NOT unary | near_expr
near_expr:= primary (NEAR[/k] primary)*  # default k = 10
primary  := '(' or_expr ')' | field? operand
field    := WORD ':'                     # e.g. title:, tags[*]:, *.name:
operand  := PHRASE | WORD                # "two words" or word
```

- `*` matches all documents; `field:*` matches documents whose field has at
  least one token.
- Operators are case-insensitive when unquoted; `NEAR` operands must be
  positional (term, phrase or `NEAR`).
- Precedence: `NEAR` > `NOT` > `AND` > `OR`.

## Library usage

```python
from docindex import Index

index = Index()
index.add_doc("d1", {"title": "the quick brown fox", "tags": ["quick brown", "fox"]})
index.set_aliases({"headline": ["title"]})
index.create_snapshot("s1")

result = index.search('headline:"quick brown" AND NOT tags[*]:dog')
# {"kind": "pos"|"bool", "doc_ids": [...], "hits": [{"doc_id", "field",
#  "paragraph", "span", "text"}, ...]}

index.apply_batch([{"op": "move_field", "doc_id": "d1", "from": "tags[0]", "to": "tags[2]"}])
index.save("store.json")
restored = Index.restore("store.json")
```

## JSON CLI

```sh
python3.11 -m docindex.cli --store db.json add --doc-id d1 --doc '{"title": "hello world"}'
python3.11 -m docindex.cli --store db.json query --q 'title:"hello world"'
python3.11 -m docindex.cli --store db.json batch --ops '[{"op": "set_field", "doc_id": "d1", "path": "meta.author", "value": "ada"}]'
python3.11 -m docindex.cli --store db.json alias --rules '{"headline": ["title"]}'
python3.11 -m docindex.cli --store db.json snapshot --name s1
python3.11 -m docindex.cli --store db.json query --q 'headline:hello' --snapshot s1
python3.11 -m docindex.cli --store db.json stats
python3.11 -m docindex.cli run --script script.json   # JSON list of commands
```

All output is JSON on stdout; errors are reported as
`{"ok": false, "error": ...}` with exit code 1.

## Layout

- `docindex/tokenizer.py` — tokens with positions, paragraphs, spans
- `docindex/fields.py` — field paths, wildcard patterns, alias rules
- `docindex/query.py` — lexer, parser, AST
- `docindex/compile.py` — dataflow operators, positional/boolean results
- `docindex/index.py` — index, atomic commits, batches, snapshots, cache, persistence
- `docindex/verify.py` — independent per-document interpreter + `cross_check`
- `docindex/cli.py` — JSON CLI
- `tests/` — unittest suite

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```
