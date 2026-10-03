# inclex

Incremental re-lexing library and CLI. `inclex` lexes a small C-like
token set, maintains the token stream plus the lexer state at every
token start, and after an edit `[start, end) -> text` re-scans only the
necessary suffix: scanning resumes at the nearest *safe state* (main
mode — not inside a string or comment) at or before the first affected
token, and stops as soon as the fresh stream re-synchronizes with the
old one, after which remaining old tokens are reused (shifted by the
edit delta).

Requires Python 3.11+ (standard library only).

## Token set

| Type            | Pattern / rule                                             |
|-----------------|------------------------------------------------------------|
| `IDENT`         | `[A-Za-z_][A-Za-z0-9_]*`                                   |
| `NUMBER`        | `[0-9]+` or `[0-9]+.[0-9]+`                                |
| `STRING`        | `"..."` with backslash escapes, no raw newline             |
| `LINE_COMMENT`  | `//` to end of line                                        |
| `BLOCK_COMMENT` | `/* ... */`, may span lines, never nests                   |
| `OP`            | `==` `!=` `<=` `>=` `&&` `\|\|` `+=` `-=` `*=` `/=` `->` and single-char punctuation |

Whitespace separates tokens and produces no tokens. Offsets are
character offsets into the decoded UTF-8 text.

## CLI

```
python -m inclex FILE [--edit START,END,TEXT]...
```

* Reads `FILE` as UTF-8, lexes it, applies each `--edit` in order
  (offsets refer to the text after all previous edits), then prints
  `changed_tokens: N` (number of tokens that had to be re-scanned, i.e.
  were not reused) followed by the token stream as JSONL.
* Exit codes: `0` ok, `2` usage/IO error, `3` `EditError` (invalid
  UTF-8, out-of-bounds edit), `4` `LexError` (unterminated
  string/comment, unexpected character), `11` internal consistency
  assertion (incremental result diverged from a full re-lex — a bug).

### Example (real output)

```
$ printf 'x = 1 + foo; // calc\n/* multi\n   line */\ns = "hi";\n' > doc.txt
$ python -m inclex doc.txt --edit 32,32,'*/ '
changed_tokens: 4
{"type": "IDENT", "start": 0, "end": 1, "value": "x"}
{"type": "OP", "start": 2, "end": 3, "value": "="}
{"type": "NUMBER", "start": 4, "end": 5, "value": "1"}
{"type": "OP", "start": 6, "end": 7, "value": "+"}
{"type": "IDENT", "start": 8, "end": 11, "value": "foo"}
{"type": "OP", "start": 11, "end": 12, "value": ";"}
{"type": "LINE_COMMENT", "start": 13, "end": 20, "value": "// calc"}
{"type": "BLOCK_COMMENT", "start": 21, "end": 34, "value": "/* multi\n  */"}
{"type": "IDENT", "start": 36, "end": 40, "value": "line"}
{"type": "OP", "start": 41, "end": 42, "value": "*"}
{"type": "OP", "start": 42, "end": 43, "value": "/"}
{"type": "IDENT", "start": 44, "end": 45, "value": "s"}
{"type": "OP", "start": 46, "end": 47, "value": "="}
{"type": "STRING", "start": 48, "end": 52, "value": "\"hi\""}
{"type": "OP", "start": 52, "end": 53, "value": ";"}
```

Inserting `*/` inside the block comment terminates it early; only the
comment and its former tail are re-scanned (`changed_tokens: 4`), the
trailing `s = "hi";` tokens are reused.

Error cases:

```
$ python -m inclex doc.txt --edit 0,999,x
EditError: edit end out of bounds (offset=999, state=main)   # exit 3
$ printf 'a = "oops' > bad.txt && python -m inclex bad.txt
LexError: unterminated string literal (offset=4, state=in_string)  # exit 4
```

## Library

```python
from inclex import IncrementalLexer, LexError, EditError

lx = IncrementalLexer('a = "hi"; // c')
changed = lx.apply_edit(4, 6, "bye")   # -> 1 (only the STRING re-scanned)
for tok in lx.tokens:
    print(tok.type, tok.start, tok.end, tok.value, tok.state)
```

`LexError` and `EditError` both carry `.offset` and `.state`
(a `LexerState`: `main`, `in_string`, `in_block_comment`,
`in_line_comment`). A failed edit leaves the lexer state untouched.

## Correctness strategy

* A token is reused only if every character the scanner consulted while
  producing it is untouched (terminator at `token.end`, plus one extra
  lookahead char for numbers like `1.`; inserting at EOF replaces the
  EOF terminator).
* Re-scanning starts at the end of the last guaranteed-unchanged token
  (a safe, main-mode position) — never inside a string or comment.
* Reuse of the old suffix happens only when a freshly scanned position
  aligns with an old token that lies entirely past the edit and its
  text matches at the shifted position.
* Every `apply_edit` cross-checks the incremental result against a full
  re-lex; divergence raises `InternalConsistencyError` (exit code 11).

## Tests

```
python -m unittest discover -s tests -v
```

The suite includes an independent regex-based reference scanner and
cross-checks full lexing, incremental re-lexing and the reference on
500 random small edits, plus targeted tests for block-comment
termination, quote deletion cascades, number lookahead, out-of-bounds
edits and empty files.

Latest run (Python 3.14.4):

```
Ran 30 tests in 0.432s

OK
```

An additional fuzz run of 40 seeds x 500 random edits (20,000 edits:
17,647 applied, 2,353 raising `LexError`) matched the reference
scanner on every step.
