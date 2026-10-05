# Test results

Environment: g++ 15.2.0, CMake 4.2.3, Linux x86-64, `-O2` (Release), C++20.

Command: `cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build && ctest --test-dir build -V`

Result: **100% tests passed, 0 tests failed out of 8** (recorded 2026-10-05).

## Actual output (key lines)

```
1: [case orient_basic]
1:   orient CCW                               sign=+1 degenerate=0 method=float-filter
1:   orient CW                                sign=-1 degenerate=0 method=float-filter
1/8 Test #1: orient_basic .....................   Passed    0.00 sec
2: [case orient_id_rule]
2:   collinear ids(1,2,3)                     sign=+1 degenerate=1 method=exact-i128
2:   collinear ids(2,1,3)                     sign=-1 degenerate=1 method=exact-i128
2:   collinear big coords                     sign=+1 degenerate=1 method=exact-bigint
2/8 Test #2: orient_id_rule ...................   Passed    0.00 sec
3: [case orient_extrema]   (6 near-collinear extrema, coords up to ±2^62)
3:   extremum  sign=-1 method=exact-bigint  model sign=-1   (det = -(2^53+1))
3:   extremum  sign=+1 method=exact-bigint  model sign=+1   (det = 2^124-1)
3:   extremum  sign=-1 method=exact-bigint  model sign=-1   (det = -(2^124-1))
3:   extremum  sign=-1 method=exact-bigint  model sign=-1   (det = -2^63)
3:   extremum  sign=+1 method=exact-bigint  model sign=+1   (det = +2^63)
3:   extremum  sign=-1 method=exact-bigint  model sign=-1   (det = -2^62)
3/8 Test #3: orient_extrema ...................   Passed    0.00 sec
4: [case orient_fuzz]   (49000 predicates vs bigint model, 0 mismatches)
4:   fuzz: filter=23285 i128=1716 bigint=23999 degenerate=8389
4/8 Test #4: orient_fuzz ......................   Passed    0.05 sec
5: [case incircle_basic]
5:   d inside                                 sign=+1 degenerate=0 method=float-filter
5:   d outside                                sign=-1 degenerate=0 method=float-filter
5/8 Test #5: incircle_basic ...................   Passed    0.00 sec
6: [case incircle_id_rule]
6:   cocircular ids(1,2,3,4)                  sign=+1 degenerate=1 method=exact-i128
6:   cocircular ids(1,2,4,3)                  sign=-1 degenerate=1 method=exact-i128
6/8 Test #6: incircle_id_rule .................   Passed    0.00 sec
7: [case incircle_extrema]   (circle R = 5^23 > 2^53, filter cannot run)
7:   d on huge circle                         sign=+1 degenerate=1 method=exact-bigint
7:   d one step inside                        sign=+1 degenerate=0 method=exact-bigint
7:   d one step outside                       sign=-1 degenerate=0 method=exact-bigint
7/8 Test #7: incircle_extrema .................   Passed    0.00 sec
8: [case incircle_fuzz]   (20000 predicates vs bigint model, 0 mismatches)
8:   fuzz: filter=18285 i128=798 bigint=917 degenerate=1715
8/8 Test #8: incircle_fuzz ....................   Passed    0.04 sec
100% tests passed, 0 tests failed out of 8
```

## Notes

- `method=` in every line is the recorded branch: `float-filter` means the
  exact branch was NOT taken; `exact-i128` / `exact-bigint` mean it was.
- Fuzz tier counters confirm all three tiers are exercised; every predicate
  result matched the arbitrary-precision model (`orient2d_model` /
  `incircle_model`), including 8389 + 1715 degenerate cases resolved by the
  ID rule.
