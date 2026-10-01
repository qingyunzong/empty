# peepbc

Safe peephole optimizer for G3-style stack-machine bytecode, with a
reference interpreter, a post-rewrite verifier, and a CLI. Pure Python
3.11+ standard library; tests use `unittest`.

## Bytecode

Stack machine over integers. Opcodes:

| Op          | Effect                                        |
|-------------|-----------------------------------------------|
| `CONST i`   | push `consts[i]`                              |
| `ADD`/`SUB`/`MUL`/`DIV`/`MOD` | pop b, pop a, push `a OP b` |
| `JMP t`     | pc = t                                        |
| `JZ t` / `JNZ t` | pop v; jump to t if v == 0 / v != 0      |
| `HALT`      | stop                                          |

`DIV`/`MOD` use truncating (C-style) semantics; division by zero is a
runtime `divzero` fault. Other fault categories: `underflow`,
`bad_jump`, `bad_const`, `step_limit`. Falling off the end halts.

Text format (`in.bc`):

```
# peepbc v1
consts:
0: 3
1: 4
code:
0: CONST 0
1: CONST 1
2: ADD
3: HALT
```

## Rewrite rules (local, semantics-preserving)

1. **Constant folding** — `CONST a; CONST b; OP` → `CONST (a OP b)`.
   `DIV`/`MOD` with `b == 0` is **never** folded: the runtime `divzero`
   fault is preserved. Patterns containing a jump target (label) in the
   second or third instruction are not folded.
2. **Identities** — `CONST 0; ADD` and `CONST 1; MUL` are removed, but
   only when the previous instruction statically guarantees a non-empty
   stack (so a hidden `underflow` fault cannot be optimized away) and
   neither instruction is a label.
3. **Jump-chain compression** — jumps targeting a `JMP` are retargeted
   to the end of the chain (cycle-safe).
4. **Dead code elimination** — instructions after an unconditional
   `JMP`/`HALT` are removed up to the next label.

The optimizer also emits a mapping `old_pc -> new_pc`; deleted
instructions map to the next executable point (or `len(code)` if none
remains). Jump targets are rewritten through this mapping.

## Verification

After rewriting, the program is verified before anything is written:

- every jump target is inside the code;
- every `CONST` index is inside the constant pool;
- the operand stack depth stays ≤ 256 on *every* path (exact
  exploration of the finite `(pc, depth)` state space).

On verification failure nothing is written and the exit code is **7**.

## CLI

```
python -m peepbc in.bc -o out.bc --verify
```

- `-o/--output` — output file (contains `consts:`, `code:` and the
  `map:` section with the `old_pc -> new_pc` mapping).
- `--verify` — print a verification report (verification always runs).
- `--max-depth N` — stack depth limit (default 256).

Exit codes: `0` success, `1` I/O or parse error, `7` verification
failure (no output written).

### Example

```
$ python -m peepbc in.bc -o out.bc --verify
peepbc: 12 -> 5 instructions (7 removed), 12 mapping entries -> out.bc
peepbc: verification OK (max stack depth <= 256)
```

## Tests

```
python -m unittest discover -s tests -v
```

Coverage includes the acceptance criteria:

- **A** (`tests/test_random.py`): 400 random programs; original and
  optimized code agree on final stack and error category, checked
  against an independent reference interpreter implemented inside the
  test. Corpus outcomes: 81 halt, 290 underflow, 28 step_limit,
  1 divzero.
- **B** (`tests/test_optimize.py::TestDivZeroPreserved`): `0/0` and
  `x%0` are not folded and still fault with `divzero` at runtime.
- **C** (`tests/test_optimize.py::TestMapping`): deleted pcs map to the
  next executable point; jumps targeting instructions past deleted or
  folded regions are retargeted through the mapping.
- **D** (`tests/test_verify.py`, `tests/test_cli.py`): programs whose
  stack depth can exceed 256 are rejected — the CLI exits with code 7
  and writes no output.

Latest run: **Ran 42 tests — OK** (Python 3.14, ~12 s).

## Layout

- `peepbc/model.py` — instruction/program model, text format parse/dump
- `peepbc/interp.py` — reference interpreter (fault categories)
- `peepbc/optimize.py` — peephole passes + old→new pc mapping
- `peepbc/verify.py` — jump/const bounds + exact stack-depth check
- `peepbc/cli.py` — `python -m peepbc` entry point
- `tests/` — unittest suite
