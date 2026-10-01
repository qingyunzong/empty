# lexpat

A mode-stack lexer with longest-match semantics, plus a CLI that turns an
input file into a JSONL token stream. Pure Python 3.11 standard library,
no dependencies.

## Spec format

A spec is a JSON object with a `rules` list. Each rule:

```json
{"name": "IDENT", "regex": "[a-z]+", "mode": "main", "push": null, "pop": false, "skip": false}
```

- `name`  – token type emitted on a match (required).
- `regex` – a Python `re` pattern; **capturing groups are forbidden**
  (use `(?:...)`), the spec is rejected otherwise.
- `mode`  – the rule is active only in this mode (default `"main"`).
- `push`  – after matching, push this mode onto the mode stack.
- `pop`   – after matching, pop the mode stack.
- `skip`  – consume the match without emitting a token.

## Lexing semantics

- Lexing starts in mode `main` with a mode stack of depth 1.
- At each input position, **all** rules of the current mode are tried;
  the **longest match wins** and ties are broken by the lowest rule index
  (so listing a keyword before the identifier rule makes the keyword win).
- Mode stack depth is limited to 64; a push that would reach depth 65
  fails, and popping the last (`main`) frame fails.
- The following are `LexError`s carrying `line`, `col`, `mode` and
  `expected` (rule names valid in the current mode):
  - a rule matching the **empty string**,
  - an **unknown character** (no rule matches),
  - an **unterminated construct** (end of input in a non-`main` mode,
    e.g. an unclosed string or nested block comment),
  - mode stack **overflow** / popping an **empty** stack.
- Each token reports `type`, `text`, `line`, `col` (1-based),
  `mode_before` and `mode_after`.
- Input files must be UTF-8; a UTF-8 BOM is rejected.

## CLI

```
python -m lexpat --spec spec.json --input file
```

On success, one JSON token per line is written to stdout and the exit
code is 0. On any error, **no partial tokens** are written to stdout, a
single JSON error object goes to stderr and the exit code is 2.

### Reproduce

```
python -m lexpat --spec /tmp/lexpat-demo/spec.json --input /tmp/lexpat-demo/input.txt
```

Real output (input: `if foo /* a /* nested */ b */ "hi"`, exit code 0):

```
{"type": "KW_IF", "text": "if", "line": 1, "col": 1, "mode_before": "main", "mode_after": "main"}
{"type": "IDENT", "text": "foo", "line": 1, "col": 4, "mode_before": "main", "mode_after": "main"}
{"type": "CMT_START", "text": "/*", "line": 1, "col": 8, "mode_before": "main", "mode_after": "comment"}
{"type": "CMT_TEXT", "text": " a ", "line": 1, "col": 10, "mode_before": "comment", "mode_after": "comment"}
{"type": "CMT_NEST", "text": "/*", "line": 1, "col": 13, "mode_before": "comment", "mode_after": "comment"}
{"type": "CMT_TEXT", "text": " nested ", "line": 1, "col": 15, "mode_before": "comment", "mode_after": "comment"}
{"type": "CMT_END", "text": "*/", "line": 1, "col": 23, "mode_before": "comment", "mode_after": "comment"}
{"type": "CMT_TEXT", "text": " b ", "line": 1, "col": 25, "mode_before": "comment", "mode_after": "comment"}
{"type": "CMT_END", "text": "*/", "line": 1, "col": 28, "mode_before": "comment", "mode_after": "main"}
{"type": "STR_START", "text": "\"", "line": 1, "col": 31, "mode_before": "main", "mode_after": "string"}
{"type": "STR_TEXT", "text": "hi", "line": 1, "col": 32, "mode_before": "string", "mode_after": "string"}
{"type": "STR_END", "text": "\"", "line": 1, "col": 34, "mode_before": "main", "mode_after": "main"}
```

Error case (input `ok\nok\n"unterminated`, exit code 2, stdout empty):

```
{"error": "unterminated construct: end of input in mode 'string'", "line": 3, "col": 14, "mode": "string", "expected": ["STR_END", "STR_TEXT"]}
```

## Library use

```python
from lexpat import Spec, lex, LexError

spec = Spec([{"name": "IDENT", "regex": "[a-z]+"}])
try:
    tokens = lex("abc", spec)
except LexError as err:
    print(err.to_dict())
```

## Tests

```
python -m unittest discover -s tests -v
```

Covers: nested block comments + string mode switching checked against an
independent character-by-character reference scanner on 200 random inputs
(acceptance A), keyword/identifier tie-breaking (B), a single precisely
located error for an unterminated string on line 3 (C), and pop-empty /
depth-65 stack failures (D), plus CLI integration tests using temporary
files (JSONL output, exit code 2 with empty stdout, BOM and non-UTF-8
rejection).

Real result of the last run (Python 3.14.4):

```
Ran 22 tests in 0.402s

OK
```

## Layout

- `lexpat/__init__.py` – library: `Spec`, `lex`, `Token`, `LexError`.
- `lexpat/__main__.py` – CLI entry point.
- `tests/test_lexer.py` – core semantics (longest match, ties, modes, errors).
- `tests/test_fuzz.py` – reference scanner + 200 random differential cases.
- `tests/test_cli.py` – end-to-end CLI tests with temporary files.
