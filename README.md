# prattx

A small Pratt (top-down operator precedence) parser library plus CLI, written
in pure Python 3.11+ standard library. Parses expressions into an AST of
nested dicts and emits it as JSON.

## Supported syntax

- Integer literals and identifiers
- Binary: `+ - * / % **`, comparisons `== != < <= > >=`, logic `&& ||`, assignment `=`
- Prefix unary: `+ - !`
- Conditional: `cond ? then : else`
- Calls `f(a, b)` and indexing `a[i]`
- Grouping parentheses (consumed, never reified into the AST — no implicit
  parenthesization nodes are added)

## Precedence and associativity

| Level | Operators | Associativity |
|------:|-----------|---------------|
| 100 | `f(...)`, `a[...]` (postfix) | left |
| 90 | `**` | right (rbp 89) |
| 80 | unary `+ - !` (prefix) | — |
| 70 | `* / %` | left |
| 60 | `+ -` | left |
| 50 | `== != < <= > >=` | left |
| 40 | `&&` | left |
| 30 | `||` | left |
| 20 | `?:` | right (rbp 19) |
| 10 | `=` | right (rbp 9, lowest) |

Because the unary rbp (80) is below the lbp of `**` (90), `-2**2` parses as
`-(2**2)`. Left-associative operators use `rbp == lbp`; right-associative
operators use `rbp == lbp - 1`.

Every AST node carries `op`, `lbp`, `rbp` and `span` (character offsets into
the source). Undeclared identifiers are **not** a parse error.

## CLI

```
python -m prattx --expr '1 + 2 * 3'
python -m prattx --file path/to/expr.txt
```

- Success: AST JSON on stdout, exit code 0.
- Syntax error: error JSON (`got`, `expected`, `span`, `message`) on stderr,
  exit code 3, and **no AST is produced**.
- Unreadable `--file`: exit code 2.

### Recorded CLI session (actual output)

```
$ python -m prattx --expr '-2**2' ; echo exit=$?
{
  "type": "unary",
  "op": "-",
  "lbp": null,
  "rbp": 80,
  "span": [0, 5],
  "operand": {
    "type": "binary",
    "op": "**",
    "lbp": 90,
    "rbp": 89,
    "span": [1, 5],
    "left":  {"type": "int", "value": 2, "op": null, "lbp": 0, "rbp": 0, "span": [1, 2]},
    "right": {"type": "int", "value": 2, "op": null, "lbp": 0, "rbp": 0, "span": [4, 5]}
  }
}
exit=0

$ python -m prattx --expr 'a(1,2][3]' ; echo exit=$?
{
  "error": {
    "type": "parse_error",
    "got": "]",
    "expected": "')'",
    "span": [5, 6],
    "message": "parse error: expected ')', got ']' at 5..6"
  }
}
exit=3
```

(The success output above is shown compacted; the real output is fully
indented JSON with the same content.)

## Library use

```python
from prattx import parse, ParseError

ast = parse("a = b ? c : d ** 2")
try:
    parse("1+")
except ParseError as err:
    print(err.got, err.expected, err.span)  # EOF expression (2, 2)
```

## Tests

```
python -m unittest discover -s tests -v
```

The suite includes an exhaustive structural check: `tests/enumerator.py`
generates **all** syntactically legal expressions of at most 5 tokens
(4548 expressions) and `tests/test_enumeration.py` compares the prattx AST of
each against `tests/oracle.py`, an independent recursive-descent
implementation of the same precedence/associativity rules.

### Recorded test run (actual output)

```
$ python -m unittest discover -s tests -v
...
test_ternary_is_right_associative (test_parser.TestAssociativityAndPrecedence) ... ok
test_unary_binds_looser_than_power (test_parser.TestAssociativityAndPrecedence) ... ok
test_undeclared_identifiers_are_not_errors (test_parser.TestAssociativityAndPrecedence) ... ok

----------------------------------------------------------------------
Ran 29 tests in 5.982s

OK
```

## Layout

- `prattx/lexer.py` — tokenizer with per-token spans
- `prattx/parser.py` — the Pratt parser and precedence table
- `prattx/errors.py` — `ParseError` (`got`, `expected`, `span`)
- `prattx/__main__.py` — CLI entry point
- `tests/` — unittest suite, enumerator and oracle
