# typedbc

A bytecode type-stack verifier based on forward abstract interpretation,
plus a CLI: `python -m typedbc prog.tbc --check`.

## Bytecode semantics

One instruction per line; `#` starts a comment. Types are `int` and `bool`;
the operand stack may hold at most 32 entries.

| Instruction        | Stack effect                  |
|--------------------|-------------------------------|
| `CONST_INT n`      | push `int`                    |
| `CONST_BOOL b`     | push `bool` (`true`/`false`)  |
| `ADD`              | pop `int,int`, push `int`     |
| `CMP`              | pop `int,int`, push `bool`    |
| `NOT`              | pop `bool`, push `bool`       |
| `JZ target`        | pop `bool`, branch to `target` or fall through |
| `JMP target`       | jump to `target`              |
| `HALT`             | end of execution              |

## Verification algorithm

1. The program is split into basic blocks (leaders: pc 0, jump targets, and
   instructions after `JZ`/`JMP`/`HALT`).
2. Each reachable block is interpreted forward with an abstract type stack.
   At every CFG join the incoming type stacks must have the **same height and
   identical element types**, otherwise `JoinError` is raised.
3. Operand type mismatches on reachable code raise `TypeFault` carrying
   `pc`, `expected`, `actual` and the `stack` snapshot.
4. Unreachable (dead) blocks must still be *structurally* legal (valid
   opcodes, in-range jump targets) but do not contribute type stacks to
   joins; type-level problems there are reported as `DeadType` warnings and
   do not fail verification.
5. Bad jump targets, operand-stack underflow and stack-height overflow
   (> 32) are `VerifyError`s.

Errors and exit codes:

| Condition                                   | Exception  | Exit code |
|---------------------------------------------|------------|-----------|
| bad jump target / underflow / overflow      | `VerifyError` | 12     |
| type mismatch on reachable code             | `TypeFault`   | 12     |
| mismatched stacks at a join point           | `JoinError`   | 12     |
| type fault in dead code                     | `DeadType` warning | 0 |
| program valid                               | —             | 0        |

On success the CLI prints a JSON report of the basic blocks (entry/exit
type stacks, successors, reachability) to stdout; `DeadType` warnings go to
stderr. A type fault in dead code therefore keeps the exit code at 0.

## Usage

```
python -m typedbc prog.tbc --check
```

Example (real output, exit code 0):

```
$ python -m typedbc examples/if_else.tbc --check
{
  "status": "ok",
  "blocks": [
    {"index": 0, "start": 0, "end": 4, "reachable": true,
     "entry_stack": [], "exit_stack": [], "successors": [2, 1]},
    ...
  ],
  "warnings": []
}
```

A dead-code type fault exits 0 with a warning on stderr:

```
$ python -m typedbc examples/dead_code.tbc --check
warning: DeadType: type fault in dead code at pc 2: expected bool, got int
```

## Testing

```
python -m unittest discover -s tests -v
```

The suite contains 31 tests and finishes in ~2 s. Acceptance coverage:

- **A** — 800 enumerated instruction sequences of depth <= 4 are
  cross-checked against an independent path-enumeration checker
  (`tests/pathcheck.py`); verdicts and failure categories must agree.
  Real distribution from the last run:
  `ok=257, verify=490, type=13, join=40` (all four categories exercised).
- **B** — if/else arms with different stack heights raise `JoinError` at
  the merge point.
- **C** — `JZ` with an `int` on top raises `TypeFault`
  (`pc=1, expected=bool, actual=int`).
- **D** — a type fault in dead code is a `DeadType` warning; exit code
  stays 0.

Real result of the last full run:

```
Ran 31 tests in 1.948s
OK
```
