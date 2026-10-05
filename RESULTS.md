# Recorded Results

Recorded on 2026-10-05 12:11 CST, node v22.22.1, tsc Version 7.0.2.

## `npm test`

```

> por-model-checker@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/differential.test.js
ok 1 - dist/test/differential.test.js
  ---
  duration_ms: 5101.44168
  type: 'test'
  ...
# Subtest: dist/test/parser.test.js
ok 2 - dist/test/parser.test.js
  ---
  duration_ms: 354.797749
  type: 'test'
  ...
# Subtest: dist/test/por.test.js
ok 3 - dist/test/por.test.js
  ---
  duration_ms: 385.974431
  type: 'test'
  ...
# Subtest: dist/test/semantics.test.js
ok 4 - dist/test/semantics.test.js
  ---
  duration_ms: 363.621972
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5123.329549
```

## Per-example comparison (test console output)

```
    ex1-read-race.prog: verdict=UNSAFE shortest=2 por{trans=6, execs=2} full{trans=8, states=8} interleavings=3
    ex2-message-passing.prog: verdict=SAFE shortest=- por{trans=18, execs=4} full{trans=23, states=19} interleavings=10
    ex3-mutex-race.prog: verdict=UNSAFE shortest=4 por{trans=14, execs=2} full{trans=20, states=18} interleavings=35
    ex4-deadlock.prog: verdict=UNSAFE shortest=2 por{trans=23, execs=5} full{trans=22, states=19} interleavings=70
    ex5-independent.prog: verdict=SAFE shortest=- por{trans=9, execs=1} full{trans=144, states=64} interleavings=1680
    ex6-max-size.prog: verdict=SAFE shortest=- por{trans=24, execs=1} full{trans=1944, states=729} interleavings=9465511770
    ex7-three-thread-unsafe.prog: verdict=UNSAFE shortest=4 por{trans=20, execs=5} full{trans=40, states=28} interleavings=20
    300 random programs: 179 unsafe, 187 with locks; all verdicts and shortest-error lengths agree
    200 lock-heavy programs: 116 unsafe, 125 with locks; all verdicts and shortest-error lengths agree
```

## CLI output on each example

### `examples/ex1-read-race.prog`

```
program: examples/ex1-read-race.prog (2 threads, 1+2 instructions)
--- POR (swap-reduced): UNSAFE (transitions=6, executions=2)
shortest error history (2 steps): assertion failed in thread 'Checker': 0 == 1 is false
  1. [Checker] read r x
  2. [Checker] assert r == 1
--- full (uncompressed): UNSAFE (transitions=8, states=8)
shortest error history (2 steps): assertion failed in thread 'Checker': 0 == 1 is false
  1. [Checker] read r x
  2. [Checker] assert r == 1
--- comparison: verdicts agree, shortest-error lengths agree, transitions 6 (por) vs 8 (full)
(exit code: 1)
```

### `examples/ex2-message-passing.prog`

```
program: examples/ex2-message-passing.prog (2 threads, 2+3 instructions)
--- POR (swap-reduced): SAFE (transitions=18, executions=4)
--- full (uncompressed): SAFE (transitions=23, states=19)
--- comparison: verdicts agree, shortest-error lengths agree, transitions 18 (por) vs 23 (full)
(exit code: 0)
```

### `examples/ex3-mutex-race.prog`

```
program: examples/ex3-mutex-race.prog (2 threads, 3+4 instructions)
--- POR (swap-reduced): UNSAFE (transitions=14, executions=2)
shortest error history (4 steps): assertion failed in thread 'Checker': 0 == 1 is false
  1. [Checker] lock m
  2. [Checker] read r x
  3. [Checker] unlock m
  4. [Checker] assert r == 1
--- full (uncompressed): UNSAFE (transitions=20, states=18)
shortest error history (4 steps): assertion failed in thread 'Checker': 0 == 1 is false
  1. [Checker] lock m
  2. [Checker] read r x
  3. [Checker] unlock m
  4. [Checker] assert r == 1
--- comparison: verdicts agree, shortest-error lengths agree, transitions 14 (por) vs 20 (full)
(exit code: 1)
```

### `examples/ex4-deadlock.prog`

```
program: examples/ex4-deadlock.prog (2 threads, 4+4 instructions)
--- POR (swap-reduced): UNSAFE (transitions=23, executions=5)
shortest error history (2 steps): deadlock: every unfinished thread is blocked on a lock
  1. [T1] lock a
  2. [T2] lock b
--- full (uncompressed): UNSAFE (transitions=22, states=19)
shortest error history (2 steps): deadlock: every unfinished thread is blocked on a lock
  1. [T1] lock a
  2. [T2] lock b
--- comparison: verdicts agree, shortest-error lengths agree, transitions 23 (por) vs 22 (full)
(exit code: 1)
```

### `examples/ex5-independent.prog`

```
program: examples/ex5-independent.prog (3 threads, 3+3+3 instructions)
--- POR (swap-reduced): SAFE (transitions=9, executions=1)
--- full (uncompressed): SAFE (transitions=144, states=64)
--- comparison: verdicts agree, shortest-error lengths agree, transitions 9 (por) vs 144 (full)
(exit code: 0)
```

### `examples/ex6-max-size.prog`

```
program: examples/ex6-max-size.prog (3 threads, 8+8+8 instructions)
--- POR (swap-reduced): SAFE (transitions=24, executions=1)
--- full (uncompressed): SAFE (transitions=1944, states=729)
--- comparison: verdicts agree, shortest-error lengths agree, transitions 24 (por) vs 1944 (full)
(exit code: 0)
```

### `examples/ex7-three-thread-unsafe.prog`

```
program: examples/ex7-three-thread-unsafe.prog (3 threads, 1+1+3 instructions)
--- POR (swap-reduced): UNSAFE (transitions=20, executions=5)
shortest error history (4 steps): assertion failed in thread 'T3': 1 == 0 is false
  1. [T1] write x 1
  2. [T3] read a x
  3. [T3] read b y
  4. [T3] assert a == b
--- full (uncompressed): UNSAFE (transitions=40, states=28)
shortest error history (4 steps): assertion failed in thread 'T3': 1 == 0 is false
  1. [T1] write x 1
  2. [T3] read a x
  3. [T3] read b y
  4. [T3] assert a == b
--- comparison: verdicts agree, shortest-error lengths agree, transitions 20 (por) vs 40 (full)
(exit code: 1)
```
