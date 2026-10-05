# Recorded test results

Environment: g++ 15.2.0 (Ubuntu), CMake 4.2.3, Linux x86-64, C++20.
Date: 2026-10-05. All runs deterministic (seeded PRNG) except thread
scheduling in test_lifetime.

## Direct test-binary output

```
$ ./build/test_basic
test_basic: all checks passed
$ ./build/test_model
test_model: 401 versions x 96 points verified against small-array copy model
$ ./build/test_lifetime
test_lifetime: snapshot survived reclamation (8126 nodes recycled)
test_lifetime: 4 readers x 8258 consistent reads, 2000 versions published
test_lifetime: all checks passed
```

test_lifetime was additionally run 50 times in a loop with zero failures
to shake out scheduling-dependent races.

## CTest — default build (RelWithDebInfo, -Wall -Wextra -Wpedantic, 0 warnings)

```

100% tests passed, 0 tests failed out of 3

Total Test time (real) =   0.05 sec
```

## CTest — ASan + UBSan (-DIX_SANITIZER=address,undefined, detect_leaks=0
because the poisoning allocator intentionally leaks reclaimed storage)

```

100% tests passed, 0 tests failed out of 3

Total Test time (real) =   0.28 sec
```

## CTest — TSan (-DIX_SANITIZER=thread)

```

100% tests passed, 0 tests failed out of 3

Total Test time (real) =   0.38 sec
```
