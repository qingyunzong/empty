# tinyvm

A small verified stack-based bytecode VM with a CLI, written in pure
Python 3.11+ standard library. Tests use `unittest`.

## Quick start

```console
$ python -m tinyvm.asm examples/fact.asm -o examples/fact.bc   # assemble
$ python -m tinyvm examples/fact.bc                            # run
{"result": 120}
$ python -m tinyvm examples/fact.bc --trace                    # trace to stderr
step=0 pc=0 op=CONST arg=1 stack=[]
step=1 pc=3 op=CALL arg=7 stack=[5]
...
```

## CLI

```
python -m tinyvm prog.bc [--trace] [--step-limit N]
```

- On a normal `HALT`, the stack top is printed to **stdout** as JSON:
  `{"result": 120}`.
- `--trace` logs every instruction to **stderr** (before execution) as
  `step=<n> pc=<n> op=<NAME> [arg=<n>] stack=[...]`. On a fault, the
  already-executed trace prefix is therefore visible on stderr and
  nothing is printed to stdout.
- Runtime failures print `tinyvm: <ErrorClass>: <message> at pc=<n>
  step=<n>` to stderr; pc and step make the exception state fully
  deterministic and reproducible.

### Exit codes

| code | condition                                  |
|------|--------------------------------------------|
| 0    | normal HALT                                |
| 3    | `RuntimeFault` (e.g. division by zero)     |
| 5    | `EmptyHalt` (HALT with empty stack)        |
| 6    | `VMError` (load/verify failure, bad file)  |
| 7    | `StackOverflow` (operand stack > 256)      |
| 8    | `FrameOverflow` (call frames > 64)         |
| 9    | `StepLimit` (steps > 1,000,000 by default) |

## Instruction set

`CONST k`, `LOAD i`, `STORE i`, `ADD`, `SUB`, `MUL`, `DIV`, `MOD`,
`JMP a`, `JZ a`, `JNZ a`, `CALL a`, `RET`, `HALT`.

Encoding: 1 opcode byte plus an optional little-endian `u16` operand
(3-byte instructions for `CONST`/`LOAD`/`STORE`/`JMP`/`JZ`/`JNZ`/`CALL`,
1-byte otherwise). `DIV`/`MOD` use Python floor semantics; division by
zero raises `RuntimeFault`. `CALL`/`RET` pass arguments and results on
the shared operand stack; each frame gets a fresh locals array.

## Bytecode container format

```
magic    4 bytes   "TVM1"
version  u8        1
nlocals  u16       locals per call frame
nconsts  u16       constant pool size
consts   nconsts * i64 (little-endian, signed)
code_len u32
code     code_len bytes
```

Load-time verification (any failure: `VMError`, exit code 6):

- magic and version match; no truncated or trailing bytes
- every instruction decodes cleanly; code ends on an instruction boundary
- `CONST` operands are valid constant pool indices
- `LOAD`/`STORE` operands are valid local indices
- `JMP`/`JZ`/`JNZ`/`CALL` targets land on an instruction boundary and
  do not exceed `code_end` (a target equal to `code_end` verifies but
  faults deterministically at runtime)

## Assembly format

```asm
.consts 1 5        # constant pool values
.locals 1          # locals per frame
main:
  CONST 1          # push consts[1] (= 5)
  CALL fact
  HALT
fact:
  STORE 0          # n = argument
  LOAD 0
  JZ base
  LOAD 0
  LOAD 0
  CONST 0          # push consts[0] (= 1)
  SUB
  CALL fact
  MUL
  RET
base:
  CONST 0
  RET
```

See `examples/fact.asm` (recursive factorial, result 120).

## Tests

```console
$ python -m unittest discover -s tests -v
```

Real result on this machine (Python 3.14.4):

```
Ran 41 tests in 5.902s

OK
```

Coverage includes the acceptance criteria:

- **A** `tests/test_expr.py`: 500 random expression trees of depth <= 3
  compiled to bytecode agree with direct Python evaluation.
- **B** `tests/test_verify.py`: a `JMP` into the middle of an
  instruction fails at load time (`VMError`, exit 6).
- **C** `tests/test_runtime.py`: recursion to depth 65 raises
  `FrameOverflow` (exit 8) with a byte-identical reproducible trace.
- **D** `tests/test_cli.py`: division by zero exits 3 while the step
  limit exits 9; the executed trace prefix goes to stderr and stdout
  stays empty on faults.
