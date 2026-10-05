# por-model-checker

A small explicit-state model checker for concurrent programs, written in
TypeScript using only Node.js built-in modules (zero runtime dependencies).
It verifies programs of **at most 3 threads with at most 8 instructions
each** over **shared integer variables**, with only four instruction kinds:
**read, write, lock/unlock, assert**. It enumerates thread interleavings in
two ways — an uncompressed full exploration and a reduced exploration that
compresses interleavings by swapping independent operations — and reports
the **shortest error history** (failing interleaving) it can prove.

## Input language

One directive per line; `#` starts a comment.

```
var x = 0            # shared integer with initial value
mutex m              # mutex declaration
thread Producer      # at most 3 threads
  write x 1          # instructions: at most 8 per thread
end
```

Instructions:

| Instruction | Meaning |
|---|---|
| `read r x` | thread-local register `r` := shared variable `x` |
| `write x k` / `write x r` | shared variable `x` := constant / register |
| `lock m` / `unlock m` | acquire / release mutex `m` (non-reentrant) |
| `assert a <op> b` | `<op>` in `== != < <= > >=`; `a`, `b` are registers or integer literals |

The parser enforces the limits (≤ 3 threads, ≤ 8 instructions per thread),
declaration-before-use of variables/mutexes/registers, and reports line
numbers on errors.

## Semantics

- Sequentially consistent interleaving of whole instructions.
- Registers are thread-local; shared state is only the declared `var`s.
- `lock m` is enabled only while `m` is free (non-reentrant; re-locking
  blocks, which can deadlock). `unlock m` by a thread that does not hold
  `m` is a modeling error.
- **Violations are recorded, not fatal**: a failed `assert` or a modeling
  error is reported and the execution continues (assertions do not mutate
  state). This is required for the reduced exploration to stay complete
  for shortest-error computation.
- A state where every unfinished thread is blocked on a lock is reported
  as a **deadlock**.

## Algorithms

**Full exploration** (`src/full.ts`): BFS over all interleavings with
visited-state deduplication. This is the uncompressed reference.

**Swap-reduced exploration** (`src/dpor.ts`): dynamic partial-order
reduction (Flanagan–Godefroid style). Two transitions of different threads
are *dependent* iff they touch the same mutex, or the same shared variable
with at least one write. Interleavings related by swapping adjacent
independent transitions form one equivalence class; the search explores
the classes instead of all interleavings, using backtrack sets updated
from dependent transition pairs on the current path, plus propagation for
threads *blocked* on a mutex (a blocked lock emits no transition, so its
dependencies would otherwise be invisible).

**Shortest error history** (`src/trim.ts`): every violation found is
trimmed to the happens-before past of its violating event (program order +
dependent cross-thread events). Replaying exactly that past still fails,
and because happens-before is invariant within an equivalence class, the
minimum over all explored classes is the globally shortest failing
interleaving. `test/por.test.ts` checks that the reported history replays
to an actual violation and that its length equals the BFS optimum.

## Usage

```sh
npm test                                # build (tsc) + run all tests
npm run build                           # compile to dist/
node dist/src/cli.js examples/ex1-read-race.prog
node dist/src/cli.js prog.prog --mode por|full|both --budget 1000000 --json
```

Exit codes: `0` = SAFE, `1` = UNSAFE (error history printed), `2` =
usage/parse error or exploration budget exhausted (`INCOMPLETE`).

Requires a TypeScript compiler (`tsc`, any recent version) on PATH; no
other dependencies. (`@types/node` is replaced by the minimal ambient
declarations in `types/node-shim.d.ts` so the build works offline.)

## Examples and results

See `examples/` and `RESULTS.md` for the recorded outputs. Headline
comparison (POR executions vs. raw interleavings):

| Example | Verdict | Shortest error | POR executions | All interleavings |
|---|---|---|---|---|
| ex1-read-race | UNSAFE | 2 | 2 | 3 |
| ex2-message-passing | SAFE | – | 4 | 10 |
| ex3-mutex-race | UNSAFE | 4 | 2 | 35 |
| ex4-deadlock | UNSAFE | 2 | 5 | 70 |
| ex5-independent | SAFE | – | 1 | 1 680 |
| ex6-max-size (3×8) | SAFE | – | 1 | 9 465 511 770 |
| ex7-three-thread-unsafe | UNSAFE | 4 | 5 | 20 |

The test suite additionally runs 500 randomized small programs (including
lock-heavy ones) and asserts that the reduced and the uncompressed
exploration always agree on the verdict and on the shortest error length.
