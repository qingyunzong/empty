# Recorded test results

Environment: g++ 15.2.0 (Ubuntu), CMake 4.2.3, 16 cores, Linux x86-64.
Recorded at 2026-10-06T01:18:28Z (Asia/Shanghai run), build type Release,
`-std=c++20 -Wall -Wextra` (no warnings).

## ctest output

```
$ ctest --test-dir build --output-on-failure
1/3 Test #1: bigint ...........................   Passed    0.04 sec
2/3 Test #2: rational .........................   Passed    0.03 sec
3/3 Test #3: reduce ...........................   Passed    4.45 sec

100% tests passed, 0 tests failed out of 3
```

Repeated 3 extra full runs: all passed (4.07s / 4.28s / 4.51s).

## Per-test check counts

```
test_bigint:   1914 checks, 0 failures
test_rational:   16 checks, 0 failures
test_reduce:     73 checks, 0 failures
```

## What was verified

- `bigint`: exact multi-limb arithmetic identities (300 random trials),
  truncated-division sign rules, gcd factorization, decimal round trips,
  known constant 2^100.
- `rational`: canonical normalization, exact H_10 = 7381/2520, exact
  geometric series (2^60-1)/2^60, zero-denominator rejection.
- `reduce` (fixed chunk tree):
  - exact rational sum of 1/(i+1), i in [0,120): parallel result equals
    the serial tree model for 1/2/3/4/8 workers;
  - barrier disorder: 12 seeds of randomized per-chunk jitter (sleeps +
    yields) with a non-associative combine over 100000 elements / 782
    chunks / 8 workers — every run reproduces the serial tree model bit
    for bit;
  - exact bigint sum of squares, n = 1000, matches n(n+1)(2n+1)/6;
  - cancellation (mid-run and pre-cancelled): status `cancelled`, no
    value, `live_buffers == 0` after return (all buffers released);
  - chunk failure at indices 25/53/90 (chunks 2/5/9): status `failed`,
    reported chunk is the minimum, 2, with the chunk-2 message;
  - empty input reduces to the default-constructed identity.
