# tinyvm

A small, verified, stack-based bytecode VM with a CLI. Pure Python 3.11+
standard library; tests use `unittest`.

## Usage

```
python -m tinyvm prog.bc [--trace]
```

* On normal `HALT` the top of the operand stack is printed to **stdout**
  as JSON (exit code 0). `HALT` on an empty stack raises `EmptyHalt`.
* `--trace` logs every executed instruction to **stderr**. On a runtime
  fault the trace of the instructions executed so far (the "trace
  prefix") has already been emitted to stderr; stdout stays clean.

Example (factorial of 10, computed by recursion):

```
$ python -m tinyvm fact10.bc
3628800

$ python -m tinyvm div0.bc --trace
step=0 pc=0000 CONST 0    stack=[] frames=1
step=1 pc=0003 CONST 1    stack=[1] frames=1
step=2 pc=0006 DIV        stack=[1, 0] frames=1
RuntimeFault: division by zero
(exit code 5)
```

## Exit codes

| code | meaning                                    |
|------|--------------------------------------------|
| 0    | success, stack top printed as JSON         |
| 2    | `StepLimit` — > 1,000,000 instructions     |
| 3    | `FrameOverflow` — > 64 call frames         |
| 4    | `StackOverflow` — > 256 operand stack slots|
| 5    | `RuntimeFault` — e.g. DIV/MOD by zero      |
| 6    | `VMError` — load-time verification failed  |
| 7    | `EmptyHalt` — HALT with empty stack        |

Division by zero (5) and step-limit exhaustion (2) deliberately exit
with different codes.

## Bytecode container format

All integers big-endian:

```
magic   : 4 bytes  "TVM1"
version : u8       (must be 1)
nconsts : u16
consts  : nconsts * i64
codelen : u32
code    : codelen bytes of instructions
```

Instruction encoding: `<opcode:u8> [operand:u16]`.

| opcode | instruction | operand            |
|--------|-------------|--------------------|
| 0x01   | CONST k     | const-pool index   |
| 0x02   | LOAD i      | local index        |
| 0x03   | STORE i     | local index        |
| 0x10–0x14 | ADD SUB MUL DIV MOD | —         |
| 0x20–0x22 | JMP JZ JNZ        | target offset |
| 0x30   | CALL n      | target offset      |
| 0x31   | RET         | —                  |
| 0xFF   | HALT        | —                  |

## Load-time verification

`tinyvm.loader.load` rejects malformed files with `VMError` (exit 6):

* wrong magic or unsupported version; truncated headers, constant pool
  or code section; trailing bytes
* unknown opcodes or truncated instructions
* `CONST` indices outside the constant pool
* `LOAD`/`STORE` local indices ≥ 256
* jump/call targets that do not land on an instruction boundary or that
  exceed `code_end` (jumping exactly to `code_end` verifies, and falling
  off the end is then a `RuntimeFault` at runtime)

## Runtime semantics

* One shared operand stack (max 256) and a call stack (max 64 frames);
  each frame has its own zero-initialised locals.
* Calling convention: the caller pushes arguments, `CALL` enters the
  callee, which `STORE`s arguments into locals and leaves its return
  value on the shared stack before `RET`.
* `DIV`/`MOD` use truncating (C-style) semantics: the quotient rounds
  toward zero, the remainder takes the sign of the dividend. A zero
  divisor raises `RuntimeFault`.
* At most 1,000,000 instructions per run (`StepLimit`).

## Layout

* `tinyvm/isa.py` — opcodes, encode/decode
* `tinyvm/loader.py` — container parsing + verification (`VMError`)
* `tinyvm/vm.py` — interpreter, limits, fault types
* `tinyvm/compiler.py` — expression-tree → bytecode compiler
* `tinyvm/asm.py` — label-resolving assembler (tests/examples)
* `tinyvm/__main__.py` — the CLI

## Tests

```
python -m unittest discover -s tests -v
```

Latest run (Python 3.14.4, this machine): **Ran 47 tests — OK**
(47 tests, 0 failures, 0 errors), covering:

* A: 500 random expressions of depth ≤ 3 — compiled bytecode result
  equals direct evaluation (`tests/test_compiler.py`)
* B: jumps into the middle of an instruction fail at load time
  (`tests/test_loader.py`)
* C: recursive factorial at depth 65 raises `FrameOverflow` with a
  reproducible trace (`tests/test_vm.py`)
* D: division by zero (exit 5) and step limit (exit 2) produce
  different exit codes (`tests/test_cli.py`)
