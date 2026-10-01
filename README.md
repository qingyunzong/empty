# shadowc

`shadowc` parses a small policy DSL into an AST, compiles it into a decision
table, and reports exact diagnostics for shadowed, unreachable and
overlapping rules.  Pure Python 3.11+ standard library; tests use
`unittest`.

## DSL

```
field port: int
field proto: string
field role: enum(admin, user)

action allow
action deny

rule ssh when port == 22 and proto == "tcp*" then allow, log
rule web when port in 80..443 or port in {8080, 8443} then allow
```

* declarations: `field <name>: int | string | enum(a, b, ...)` and
  `action <name>`; declarations must precede use.
* rules: `rule <name> when <condition> then <action>[, <action>...]`
  (an empty action list is `E_PARSE`).
* conditions: integer intervals (`f in 1..10`), enumerations
  (`f in {1, 2}` / `f in {a, b}`), equality (`f == v`), prefix wildcards
  (`f == "tcp*"`, string fields only), combined with `and` / `or` / `not`
  and parentheses.  `#` starts a line comment.
* unknown fields, unknown actions, unknown enum values, type mismatches,
  empty intervals and misplaced wildcards are all `E_PARSE` with an exact
  1-based line/column.

## Semantics

Every condition denotes a set of inputs.  Sets are represented exactly:
sorted disjoint integer intervals, prefix-cylinder/exact-string unions
(complemented over a finite quotient alphabet: the characters used by the
policy plus a sentinel), and enum subsets.  Spaces are unions of cubes
(per-field products), closed under union/intersection/complement, so
inclusion is decidable.

* **E_SHADOW** (error): rule B's input space is non-empty and is a subset
  of an *earlier* rule A's space.
* **E_UNREACHABLE** (error): B's space is covered by the *union* of all
  earlier rules (or B's condition is unsatisfiable).
* **W_OVERLAP** (warning only, never fails the build): B overlaps an
  earlier rule A but neither contains the other.
* Diagnostics never change evaluation: the table keeps every rule in
  source order and evaluation is first-match-wins.

## CLI

```
python -m shadowc compile policy.dsl --report out.json
```

Writes `{"table": [...], "diagnostics": [...]}` (stdout if `--report` is
omitted).  Exit codes:

* `0` -- compiled, at most warnings
* `1` -- compiled, error-severity diagnostics present (report still written)
* `2` -- `PolicyError` (`E_PARSE`) or I/O failure, no report written

## Tests

```
python -m unittest discover -s tests -v
```

(Use `python3` if `python` is not on PATH.)

Latest recorded run (Python 3.14.4, this workspace): **58 tests, 0 failures,
~17s** (`Ran 58 tests in 16.876s -- OK`).  This includes the fuzz test
comparing exact diagnostics against a sampling-based reference inclusion
check on random policies of up to 80 rules.
