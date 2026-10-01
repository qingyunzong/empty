# hmtype

Hindley-Milner type inference for a mini ML-like language, with a CLI
that prints the principal type of every top-level `let` (or JSON errors).
Pure Python 3.11 standard library; tests use `unittest`.

## Language

```
expr := int | true | false | x
      | fun x -> expr
      | expr expr                      -- application
      | let x = expr in expr
      | if expr then expr else expr
      | fix f -> expr                  -- recursive binder
      | expr (+|-|*|<|>|<=|>=|=|<>) expr
      | (expr, expr, ...)              -- tuples
```

A file is a sequence of top-level `let x = expr` declarations, one per
line (expressions may span lines inside parentheses). `--` starts a
line comment. Arithmetic operators are `int -> int -> int`; comparison
operators are `int -> int -> bool`.

## Semantics

- **Let polymorphism**: full Hindley-Milner generalisation at `let`.
- **Value restriction**: only syntactic values (lambdas and literals)
  are generalised; a `let` whose right-hand side is an application
  (e.g. `let r = (fun x -> x) (fun y -> y)`) stays monomorphic.
- **Occurs check**: unification rejects infinite types
  (`fun x -> x x`) with an `OccursError`.
- **Error recovery**: after a type error the offending subterm gets a
  fresh type variable and inference continues; at most **5** errors are
  reported per file, then inference stops and the CLI exits with code 4.
- **Principal types**: free variables are named `a`, `b`, `c`, ... in
  order of appearance.

## CLI

```
python -m hmtype src.mini
```

Types are printed to stdout as `name : type`; errors are printed to
stderr as one JSON object per line with `kind`, `expected`, `actual`,
`span` and `env_snapshot` fields. Exit codes: `0` success, `4` any
error (type, occurs or parse), `2` usage/IO errors.

Real output for the bundled `src.mini`:

```
$ python -m hmtype src.mini
id : a -> a
both : (int, bool)
const : a -> b -> a
fact : int -> int
cmp : int -> int -> bool
```

Error example (`let bad1 = (fun x -> x + 1) true`, then four more bad
declarations — real output, stderr shown):

```
{"kind": "TypeError", "expected": "int", "actual": "bool", "span": {"line": 1, "col": 13, "end_line": 1, "end_col": 33}, "env_snapshot": {}}
{"kind": "OccursError", "expected": "a", "actual": "a -> b", "span": {"line": 2, "col": 21, "end_line": 2, "end_col": 24}, "env_snapshot": {"bad1": "a", "x": "a"}}
{"kind": "TypeError", "expected": "bool", "actual": "int", "span": {"line": 3, "col": 15, "end_line": 3, "end_col": 16}, "env_snapshot": {"bad1": "a", "bad2": "a -> b"}}
{"kind": "TypeError", "expected": "int", "actual": "bool", "span": {"line": 4, "col": 12, "end_line": 4, "end_col": 21}, "env_snapshot": {"bad1": "a", "bad2": "a -> b", "bad3": "int"}}
{"kind": "TypeError", "expected": "int", "actual": "int -> a", "span": {"line": 5, "col": 13, "end_line": 5, "end_col": 28}, "env_snapshot": {"bad1": "a", "bad2": "a -> b", "bad3": "int", "bad4": "int"}}
(exit code 4; the 6th error and remaining declarations are not processed)
```

## Tests

```
python -m unittest discover -s tests -v
```

Real result (Python 3.14.4, this machine):

```
Ran 22 tests in ~3s
OK
acceptance A: 136 well-typed, 164 ill-typed out of 300 terms (seed=20261001, depth<=4)
```

The suite covers:

- **Acceptance A** (`tests/test_acceptance.py`): 300 randomly generated
  closed terms of depth <= 4 are cross-validated against
  `hmtype/check.py`, an independent reference implementation (textbook
  Algorithm W with explicit substitutions). Both must agree on
  typability and on the principal type.
- **Acceptance B/C/D** (`tests/test_infer.py`, `tests/test_cli.py`):
  `let id = fun x -> x in (id 1, id true)` type-checks;
  `fun x -> x x` raises `OccursError`; `(fun x -> x + 1) true` reports
  `expected: int, actual: bool`; more than 5 errors is capped at 5 and
  output is byte-for-byte stable across runs.

## Layout

- `hmtype/lexer.py`, `hmtype/parser.py` — tokens and recursive-descent parser
- `hmtype/types.py` — type representation, unification with occurs check
- `hmtype/infer.py` — HM inference, value restriction, error recovery (max 5)
- `hmtype/check.py` — independent reference checker (used only by tests)
- `hmtype/__main__.py` — CLI entry point
