# rex — register expression library

A C++20 (header-only) library for typed bit-vector expressions over
registers, with a parser, a tree-walking evaluator, and a pausable
stack-bytecode compiler/VM.

## Language

Values are unsigned bit vectors. Registers and literals are 8 to 64
bits wide; slices, comparisons and logical operators may produce
narrower results.

```
cond    := or_expr ('?' cond ':' cond)?
or_expr := and_expr ('||' and_expr)*
and_expr:= eq_expr ('&&' eq_expr)*
eq_expr := add_expr (('=='|'!=') add_expr)*
add_expr:= shift_expr ('+' shift_expr)*
shift   := postfix (('<<'|'>>') postfix)*
postfix := primary ('[' NUM (':' NUM)? ']')*
primary := NUM | NUM '\'' ('b'|'d'|'h') DIGITS | IDENT
         | '(' cond ')' | '{' cond (',' cond)* '}'
```

- `r0 + r1` — addition modulo the result width (operands must have
  equal widths).
- `x << n`, `x >> n` — shifts; a shift amount at or beyond the width
  yields zero. Result width is the shifted value's width.
- `x[hi:lo]`, `x[i]` — slices; out-of-range or reversed slices are
  rejected at parse time.
- `{a, b, ...}` — concatenation, first element most significant; the
  total width may not exceed 64 bits.
- `a == b`, `a != b`, `a && b`, `a || b`, `c ? a : b` — 1-bit results
  for comparisons/logicals; `&&`, `||` and `?:` short-circuit.
- Literals: plain decimal (width inferred, minimum 8) or sized
  `8'hff`, `16'd1000`, `8'b1010`; a literal that does not fit its
  width is a parse error.

Parentheses and whitespace are pure grouping: they never change the
meaning of an expression (`ast_equal` compares trees ignoring source
positions). All parse errors carry a byte offset (`ParseError::pos`).

Reading a declared but unwritten register is a runtime error — but
only if execution actually reaches it: branches skipped by the
short-circuiting operators stay silent.

## Pipeline

```
source --Parser--> Expr (typed AST) --eval--> Value
                       |
                    compile --> Program --verify--> ok / error
                                       |
                                       VM (pausable)
```

- `rex::Parser(src, regs).parse()` — parses and type-checks.
- `rex::eval(expr, regfile)` — reference tree-walking evaluator.
- `rex::compile(expr, regs)` — emits stack bytecode; conditionals
  compile to jumps.
- `rex::verify(program)` — dataflow verifier: every instruction
  boundary (in particular every jump entry) must be reached with one
  consistent stack type; also checks underflow, operand widths and
  the single result value at `Halt`.
- `rex::VM` — pausable interpreter: `step()` executes one
  instruction, `run(fuel)` at most `fuel`; the machine state is plain
  copyable data, so execution can be suspended at any instruction
  boundary and resumed later (or duplicated) with results identical
  to AST evaluation.

## Build and test

```
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

Tests (`tests/`):

- `test_parser` — widths, grouping invariance, error byte positions,
  illegal slices, literal range checks.
- `test_semantics` — modular addition, zero-yielding wide shifts,
  slices/concat, short-circuit and unwritten-register behavior.
- `test_vm` — VM vs AST agreement, resume from every instruction
  boundary, verifier acceptance/rejection of hand-crafted bytecode.
- `test_exhaustive` — enumerates all 65536 inputs of two 8-bit
  registers for fixed and randomly generated expressions, checking
  VM output against AST evaluation on every input.
