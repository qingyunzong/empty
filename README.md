# inclex — incremental re-lexing library and CLI

`inclex` keeps a token stream for a text document and, after an edit
`[start, end) -> text`, re-lexes **only** from the nearest safe state
instead of rescanning the whole file.  A safe state is the lexer main
mode: not inside a string or a comment.  Every token records the lexer
state at its start, so the nearest safe rescan point is the start of the
first token that may be affected by the edit.

Pure Python 3.11+ standard library; tests use `unittest`.

## Lexer rules (simplified-pattern lexer)

- `IDENT` — `[A-Za-z_][A-Za-z0-9_]*`
- `NUMBER` — `[0-9]+(\.[0-9]+)?`
- `STRING` — `"..."` or `'...'` with `\` escapes, no raw newline inside
- `LINE_COMMENT` — `//` to end of line
- `BLOCK_COMMENT` — `/* ... */`, may span lines, does **not** nest
- `OP` — multi-char first (`== != <= >= && || += -= *= /= ++ -- -> << >>`),
  then single-char operators/punctuation
- whitespace is skipped; anything else is a `LexError`

## Incremental algorithm

1. Validate the edit (`EditError` on out-of-bounds ranges).
2. Find the first token with `token.end >= start` — a token ending exactly
   at the edit point can still merge with the new text.  Its start is the
   nearest safe state (main mode); rescanning begins there.
3. Re-lex token by token.  After each fresh token, check
   resynchronisation against the old stream: an old token lying fully
   beyond the edited region whose type, text and shifted start
   (`old.start + delta`) all match.  On a match the remaining old tokens
   are reused verbatim (shifted by `delta`).
4. `changed_tokens` = number of tokens actually re-lexed.
5. **Internal assertion**: the incremental result is compared token-by-
   token against a full rescan (`lex_full`).  Any divergence raises
   `InternalConsistencyError` and the CLI exits with code **11**.

## CLI

```
python -m inclex doc.txt [--edit start,end,text]
```

- Reads `doc.txt` as UTF-8 (invalid UTF-8 -> `EditError`, exit 1).
- Without `--edit`: lexes the file; `changed_tokens` equals the token count.
- With `--edit start,end,text`: replaces the half-open range `[start,end)`
  with `text` (the file on disk is not modified; `text` may contain
  commas) and re-lexes incrementally.
- Output: one JSON header line `{"changed_tokens": N, "token_count": M}`
  followed by the tokens as JSONL (one JSON object per line).
- Exit codes: `0` ok, `1` `EditError`/`LexError` (JSON with
  `error`/`offset`/`state` on stderr), `2` usage/IO error,
  `11` internal consistency assertion failure.

### Real CLI results

```
$ printf 'a /* hello */ b\n' > /tmp/ex1.txt
$ python -m inclex /tmp/ex1.txt
{"changed_tokens": 3, "token_count": 3}
{"type": "IDENT", "text": "a", "start": 0, "end": 1, "state": "main"}
{"type": "BLOCK_COMMENT", "text": "/* hello */", "start": 2, "end": 13, "state": "main"}
{"type": "IDENT", "text": "b", "start": 14, "end": 15, "state": "main"}
```

Inserting `*/` in the middle of the block comment affects only the
necessary suffix (`a` untouched, `b` reused; `changed_tokens` = 4):

```
$ python -m inclex /tmp/ex1.txt --edit 7,7,*/
{"changed_tokens": 4, "token_count": 6}
{"type": "IDENT", "text": "a", "start": 0, "end": 1, "state": "main"}
{"type": "BLOCK_COMMENT", "text": "/* he*/", "start": 2, "end": 9, "state": "main"}
{"type": "IDENT", "text": "llo", "start": 9, "end": 12, "state": "main"}
{"type": "OP", "text": "*", "start": 13, "end": 14, "state": "main"}
{"type": "OP", "text": "/", "start": 14, "end": 15, "state": "main"}
{"type": "IDENT", "text": "b", "start": 16, "end": 17, "state": "main"}
```

Deleting a string quote cascades to EOF (one quote was hidden inside the
trailing block comment and becomes live; nothing can be reused):

```
$ printf '"a" m "b" /* " */' > /tmp/ex2.txt
$ python -m inclex /tmp/ex2.txt --edit 2,3,
{"changed_tokens": 5, "token_count": 5}
{"type": "STRING", "text": "\"a m \"", "start": 0, "end": 6, "state": "main"}
{"type": "IDENT", "text": "b", "start": 6, "end": 7, "state": "main"}
{"type": "STRING", "text": "\" /* \"", "start": 7, "end": 13, "state": "main"}
{"type": "OP", "text": "*", "start": 14, "end": 15, "state": "main"}
{"type": "OP", "text": "/", "start": 15, "end": 16, "state": "main"}
```

Error cases (exit code 1, JSON on stderr):

```
$ python -m inclex /tmp/ex2.txt --edit 0,99,x
{"error": "edit end out of bounds", "offset": 99, "state": "main"}
$ printf '\xff\xfe' > /tmp/ex3.txt && python -m inclex /tmp/ex3.txt
{"error": "invalid UTF-8: invalid start byte", "offset": 0, "state": "decode"}
$ printf 'a "open' > /tmp/ex4.txt && python -m inclex /tmp/ex4.txt
{"error": "unterminated string literal", "offset": 2, "state": "in_string"}
```

## Library

```python
from inclex import Document, EditError, LexError

doc = Document("a /* hello */ b")
result = doc.edit(7, 7, "*/")
result.changed_tokens   # 4
result.tokens           # full token stream after the edit
```

`EditError` and `LexError` carry `.offset` and `.state` attributes.

## Tests

```
python -m unittest discover -s tests -v
```

Coverage:

- **A** (`tests/test_random_edits.py`): 500 seeded random small edits;
  every result is compared against a full rescan *and* an independent
  regex-based reference scanner (`tests/reference.py`), including
  matching `LexError` offset/state on unterminated constructs.
- **B** (`tests/test_incremental.py::TestBlockCommentSuffix`): inserting
  `*/` inside a block comment touches only the necessary suffix.
- **C** (`tests/test_incremental.py::TestStringQuoteDeletion`): deleting
  a string quote rescans the whole suffix to EOF.
- **D** (`tests/test_incremental.py::TestBoundaries`): out-of-bounds
  edits and empty-file edges are stable; failed edits leave the document
  unchanged.
- CLI end-to-end tests incl. exit codes 1/2/11 (`tests/test_cli.py`).

Real result of the last run:

```
Ran 38 tests in 2.665s

OK
```

## Layout

- `inclex/lexer.py` — tokens, states, `scan_token`, `lex_full`, `LexError`
- `inclex/incremental.py` — `Document.edit`, `EditError`,
  `InternalConsistencyError`
- `inclex/__main__.py` — CLI entry point
- `tests/` — unittest suite + independent reference scanner
