# hmtype

Hindley-Milner type inference for a mini ML-like language, with a CLI
that prints the principal type of every top-level `let` (or a JSON
error). Pure Python 3.11+ standard library; tests use `unittest`.

## Language

```
expr := "let" x "=" expr "in" expr
      | "fun" x "->" expr
      | "if" expr "then" expr "else" expr
      | "fix" expr                       (* fix : (a -> a) -> a *)
      | expr ("<"|"<="|">"|">="|"=="|"!=") expr
      | expr ("+"|"-") expr | expr ("*"|"/") expr
      | expr expr                        (* application *)
      | INT | "true" | "false" | x | "-" expr
      | "(" expr ")" | "(" expr "," expr ("," expr)* ")"   (* tuples *)
```

A `.mini` file is a sequence of top-level `let x = e` definitions
(optionally separated by `;;`); `#` starts a line comment. See
`src.mini` for an example.

## Semantics

- **Let polymorphism**: `let`-bound values are generalized, so
  `let id = fun x -> x in (id 1, id true)` has type `(int * bool)`.
- **Value restriction**: only lambdas and literals are generalized.
  A `let` whose right-hand side is an application (or any other
  non-value) stays monomorphic.
- **Occurs check**: unification refuses infinite types, e.g.
  `fun x -> x x` raises `OccursError`.
- **Errors**: type errors carry `expected`, `actual`, `span`
  (1-based `[start_line, start_col, end_line, end_col]`) and an
  `env_snapshot` of the typing environment at the failure point.
  Recovery happens at top-level-let boundaries: after an error the
  next `let` is still processed, but at most **5** errors are reported
  per file before stopping.
- **Output**: principal types are printed with free variables named
  `a`, `b`, `c`, ... in order of first appearance.

## CLI

```
python -m hmtype src.mini
```

prints one line per top-level let — `name : type` on success or a JSON
error object — and exits with code `0` if everything type-checks, `4`
if any error was reported, `2` for usage/IO errors.

Real run on the bundled `src.mini` (exit code `0`):

```
id : a -> a
const : a -> b -> a
compose : (a -> b) -> (c -> a) -> c -> b
pair : (int * bool)
add : int -> int -> int
is_pos : int -> bool
fact : int -> int
answer : int
```

Real run on a file containing `let f = fun x -> x x`,
`let g = (fun x -> x + 1) true` and `let ok = fun x -> x`
(exit code `4`; note recovery continues after each error):

```
{"let": "f", "error": "OccursError", "message": "occurs check failed: cannot construct the infinite type a = a -> b", "span": [1, 18, 1, 21], "env_snapshot": {"x": "a"}, "var": "a", "in_type": "a -> b"}
{"let": "g", "error": "TypeError", "message": "type mismatch: expected int, got bool", "span": [2, 9, 2, 30], "env_snapshot": {}, "expected": "int", "actual": "bool"}
ok : a -> a
```

## Tests

```
python -m unittest discover -s tests -v
```

Latest run: **31 tests, OK** (~4 s). Coverage includes:

- `tests/test_infer.py` — let polymorphism, value restriction, occurs
  check, error fields/recovery and the 5-error limit.
- `tests/test_random.py` — 300 randomly generated closed terms of
  depth ≤ 4: each term is generated together with a ground type, and
  the inferred principal type is cross-checked against an independent
  oracle that enumerates ground-type assignments for lambda-bound
  variables and runs a structural (unification-free) check; every type
  the oracle accepts must be an instance of the inferred principal
  type.
- `tests/test_cli.py` — end-to-end CLI runs: output format, JSON
  errors, exit codes `0`/`4`/`2`, and the 5-error cut-off.

## Layout

- `hmtype/types.py` — type representation, pruning, pretty-printing.
- `hmtype/syntax.py` — lexer, parser, AST (all nodes carry spans).
- `hmtype/infer.py` — unification with occurs check, schemes,
  generalization/instantiation, program-level driver with recovery.
- `hmtype/errors.py` — `TypeError`/`OccursError`/`UnboundVariable`/
  `ParseError` with JSON serialization.
- `hmtype/__main__.py` — CLI entry point.
