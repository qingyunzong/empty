# AST test-case reducer

A C++20 test-case reducer over a small S-expression AST. It minimizes a
program while a bad-predicate (here: the program crashes with a division by
zero) keeps reproducing.

## Guarantees

- **Syntactic validity**: candidates are built structurally and every trial
  candidate round-trips through `parse(print(x))`.
- **Genuine reproduction**: a candidate is accepted only if the
  bad-predicate still holds (the real crash, not any other error).
- **Local minimum**: the fixpoint loop terminates only when no single local
  transformation (`shrink-int`, `delete-node`, `shorten-list`) yields a
  smaller bad AST (`is_local_minimum`).
- **Environment-aware caching**: cache keys are `env_id + program text`;
  the env id comes from `uname` + C++ version (override with
  `REDUCER_ENV_ID`).
- **Full trial trajectory**: every predicate query is logged (transform,
  size, verdict, accept/reject, cache hit).
- **Bounded verification**: `verify_bounded` enumerates all ASTs up to a
  given size and checks round-trip validity, predicate determinism and
  cache/fresh verdict agreement.

## Build & test

```sh
cmake -B build && cmake --build build
ctest --test-dir build --output-on-failure
```

## Usage

```sh
./build/reduce program.sexp   # reduce file, print result + trial trajectory
./build/reduce verify 5       # bounded bad-predicate verification
```

Example input:

```
(seq (add 1 2) (mul 3 4) (div 8 0) (sub 5 5))
```

reduces to the local minimum `(div 0 0)`.
