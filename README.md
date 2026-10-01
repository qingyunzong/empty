# Incremental Spreadsheet Cell Evaluator

A dependency-graph-driven spreadsheet engine with minimal invalidation
propagation and deterministic recomputation. Pure Python standard library
(compatible with Python 3.11+), no third-party dependencies.

## Usage

```
python -m sheet [script_file]     # reads commands from the file, or stdin
```

Commands (one per line; blank lines and `#` comments are ignored):

- `set <cell> <expr>` — set a cell to an expression (an optional `=` after the cell is accepted)
- `del <cell>` — delete a cell: equivalent to setting it to 0 and dropping its outgoing edges
- `get <cell>` — print the cell's current value
- `dump` — print all defined cells as `NAME = VALUE`, sorted by cell name (dictionary order)

Expressions support integers, `+ - * /`, parentheses, unary `+`/`-`, and cell
references (e.g. `B1`). Division is truncating integer division.

Example:

```
$ printf 'set A1 = B1 + 1\nset B1 = C1 + 1\nset C1 41\nget A1\ndump\n' | python -m sheet
warning: undefined reference to B1, treated as 0
43
A1 = 43
B1 = 42
C1 = 41
```

## Semantics

- **Acyclic graph**: a `set` that would close a reference cycle fails
  atomically — the whole state is left unchanged and the CLI exits with code 3.
- **Minimal invalidation**: after a change, only affected ancestors whose
  value may change are recomputed (topological order, each node at most once);
  untouched cells keep their version numbers.
- **Delete**: `del` behaves as setting the cell to 0 and removing its
  outgoing dependency edges; dependents are re-evaluated accordingly.
- **Idempotent set**: re-setting the identical expression is a no-op and
  triggers no propagation.
- **Errors**: division by zero yields the sticky error value `E_DIV0`.
  Undefined references evaluate to 0 and emit a `warning:` line to stderr.

Exit codes: `0` ok, `2` parse/usage error, `3` reference cycle.

## Layout

- `sheet/parser.py` — tokenizer and recursive-descent parser producing a tuple AST
- `sheet/engine.py` — `Sheet` engine: dependency graph, cycle check, Kahn-ordered
  minimal propagation, evaluation
- `sheet/cli.py` / `sheet/__main__.py` — command-line interface
- `tests/test_sheet.py` — unittest suite

## Test Results (actually executed)

Environment: Python 3.14.4 (code uses only Python 3.11 standard-library
features), Linux.

Command:

```
python -m unittest discover -s tests -v
```

Result: **Ran 23 tests — 23 passed, 0 failed (OK)**, including the acceptance
scenarios:

- A: chain `A1=B1+1, B1=C1+1` — changing `C1` recomputes exactly 3 cells
- B: diamond with shared subexpression — each node recomputed exactly once
- C: cycle `A1=B1, B1=A1` — atomic failure, state unchanged, CLI exit 3
- D: 20 random seeds x 20-node random DAGs with random set/del workloads —
  incremental results match a brute-force full-recompute oracle
