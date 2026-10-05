# Recorded test results

Environment: g++ 15.2.0 (Ubuntu), CMake 4.2.3, `-O3 -DCMAKE_BUILD_TYPE=Release`,
date 2026-10-05. Command: `ctest -V` in `build/`.

```
1/8 Test #1: bigint_model .....................   Passed    0.04 sec
2/8 Test #2: orient_basic .....................   Passed    0.01 sec
3/8 Test #3: orient_degenerate_id .............   Passed    0.01 sec
4/8 Test #4: orient_near_collinear ............   Passed    0.01 sec
5/8 Test #5: orient_fuzz ......................   Passed    0.19 sec
6/8 Test #6: incircle_basic ...................   Passed    0.01 sec
7/8 Test #7: incircle_near_cocircular .........   Passed    0.01 sec
8/8 Test #8: incircle_fuzz ....................   Passed    0.47 sec
100% tests passed, 0 tests failed out of 8
```

## Exact-branch usage actually observed

- `orient_fuzz`: **1 / 200000** random cases fell through to the exact branch
  (a randomly generated exactly-collinear triple); all matched the
  arbitrary-precision model.
- `incircle_fuzz`: **0 / 100000** random cases needed the exact branch — the
  float filter certified every random sign.
- `orient_near_collinear`: Cassini case `det = F45² - F44·F46 = 1`
  (permanent ≈ 2.6e18) and the int64-extreme case `det = 2^63 - 1`
  (permanent ≈ 2^124) both reported `used_exact = true` and agreed with the
  BigInt model (`+` and its swapped `-`).
- `incircle_near_cocircular`: 3-4-5 circle scaled by 2^58 — the exactly
  cocircular point gave exact `0` (then the ID rule), and the ±1-unit
  perturbations both took the exact branch and matched the model
  (`+` inside, `-` outside).
- Degenerate ID rule: collinear `(1,2,3)` IDs → `+`, swapped `(1,3,2)` → `-`;
  cocircular `(1,2,3,4)` → `+`, `(1,2,4,3)` → `-`; duplicate IDs → `0`;
  `sos_tiebreak=false` → exact `0`.
