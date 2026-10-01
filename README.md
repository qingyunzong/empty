# typedbc

A type-stack verifier for a tiny stack bytecode, built on forward abstract
interpretation over basic blocks, plus a CLI:

```
python -m typedbc prog.tbc --check
```

Pure Python 3.11+ standard library; tests use `unittest`.

## Bytecode and `.tbc` format

One instruction per line; blank lines and `#` comments are ignored.
`pc` is the 0-based instruction index.

| Instruction        | Effect on the type stack                |
|--------------------|------------------------------------------|
| `CONST_INT <n>`    | push `int`                               |
| `CONST_BOOL <b>`   | push `bool` (`true`/`false`)             |
| `ADD`              | pop `int`, pop `int`, push `int`         |
| `CMP`              | pop `int`, pop `int`, push `bool`        |
| `NOT`              | pop `bool`, push `bool`                  |
| `JZ <target>`      | pop `bool`; branch to `target` or fall through |
| `JMP <target>`     | jump to `target`                         |
| `HALT`             | stop (no successors)                     |

Types are `int` and `bool`; the stack height limit is 32. Running off the
end of the program is an implicit `HALT`.

## Verification semantics

- **Abstract interpretation.** The abstract state is the concrete type
  stack (bounded to 32 entries). Each basic block is interpreted forward
  once its input state is known; the analysis terminates because the first
  state to reach a block fixes it.
- **Joins.** At CFG merge points the incoming type stacks must have equal
  height and equal element types, otherwise `JoinError` (carries `pc`,
  `expected`, `actual`).
- **Type faults.** Wrong operand types raise `TypeFault` with `pc`,
  `expected`, `actual` and a snapshot of the `stack` before the faulting
  instruction (e.g. `JZ` with `int` on top, `ADD` on non-`int`).
- **Structural errors.** Bad jump targets, stack underflow and stack height
  overflow (>32) raise `VerifyError`. Structural checks cover the whole
  program, including dead code.
- **Dead code.** Unreachable blocks do not participate in runtime typing.
  They must still be structurally legal; type problems found in them are
  reported as `DeadType` warnings only and do not affect the exit code.

## CLI

```
python -m typedbc prog.tbc --check
```

- Exit `0`: program verifies; prints the basic-block analysis as JSON to
  stdout. `DeadType` warnings are printed to stderr and still exit `0`.
- Exit `12`: `VerifyError`, `TypeFault` or `JoinError` (message on stderr).
- Exit `2`: usage/IO error (e.g. missing file).

### Real output (`examples/ok.tbc`)

```
$ python -m typedbc examples/ok.tbc --check ; echo exit=$?
{
  "ok": true,
  "max_stack_height": 32,
  "blocks": [
    {"start": 0, "end": 4, "reachable": true, "in": [], "out": [], "successors": [4, 5]},
    {"start": 4, "end": 5, "reachable": true, "in": [], "out": [], "successors": []},
    {"start": 5, "end": 6, "reachable": true, "in": [], "out": [], "successors": []}
  ],
  "warnings": []
}
exit=0
```

(JSON pretty-printed here; block objects also carry `end`, `reachable`,
`in`, `out`, `successors`.)

### Real output (`examples/dead.tbc`, dead-code type error)

```
$ python -m typedbc examples/dead.tbc --check ; echo exit=$?
typedbc: warning: DeadType at pc 4: stack underflow at pc 4; stack=[]
{ ... "warnings": [{"kind": "DeadType", "pc": 4, ...}] ... }
exit=0
```

### Error cases

```
$ python -m typedbc bad.tbc --check ; echo exit=$?     # CONST_INT 5 / JZ 2 / HALT
typedbc: TypeFault: TypeFault at pc 1: expected bool, got int; stack=['int']
exit=12

$ python -m typedbc join.tbc --check ; echo exit=$?    # if-arms disagree on stack height
typedbc: JoinError: JoinError at pc 6: incoming stack ['int', 'int'] does not match ['int']
exit=12
```

## Library use

```python
from typedbc import parse, verify, JoinError, TypeFault, VerifyError

prog = parse(open("prog.tbc").read())
try:
    result = verify(prog)      # VerifyResult(blocks, warnings)
except (TypeFault, JoinError, VerifyError) as exc:
    ...
```

## Tests

```
python -m unittest discover -s tests -v
```

The suite includes a differential fuzz test (acceptance case A): 800
programs of depth <= 4 instructions (110 systematically enumerated over a
reduced alphabet + 690 seeded-random over the full alphabet) are checked
both by `typedbc.verify` and by an independent path-enumeration checker
(`tests/reference_checker.py`), and their verdicts must agree. Corpus
verdict distribution: 319 ok, 406 VerifyError, 59 TypeFault, 16 JoinError.

Real run on this machine (Python 3.14.4):

```
Ran 25 tests in 2.695s

OK
```

## Layout

- `typedbc/isa.py` — instruction set and `.tbc` parser
- `typedbc/verifier.py` — abstract interpretation, joins, dead-code warnings
- `typedbc/errors.py` — `VerifyError` / `TypeFault` / `JoinError` / `DeadType`
- `typedbc/__main__.py` — CLI entry point
- `tests/` — unit, CLI and differential fuzz tests
- `examples/` — sample `.tbc` programs
