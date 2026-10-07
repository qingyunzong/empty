# sigconv — exact convolution of signed 64-bit sequences

`sigconv` convolves two sequences of signed 64-bit integers and prints the
exact result as arbitrary-precision decimal integers. No truncation, no
floating point: all arithmetic is exact.

## Build & test

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

## Usage

```sh
sigconv <fileA> <fileB>   # whitespace-separated int64 values per file
sigconv                   # or: sequence A on stdin line 1, B on line 2
```

Prints the `n + m - 1` convolution coefficients, space-separated, to stdout.
A proof report (coefficient bound `B`, reconstruction modulus `M`, and the
verified inequality `M > 2B`) is printed to stderr. Total input length
`n + m` may be at most 200000.

## Why the result is exact

Each output coefficient is a sum `c_k = sum a_i b_j` of at most
`L = min(n, m)` products, so `|c_k| <= B = L * max|a| * max|b|` (worst case
here: `B < 2^18 * 2^63 * 2^63 = 2^144`, i.e. far beyond 64 or 128 bits).

1. **Modular transforms.** The convolution is evaluated modulo several
   NTT primes `p_i` (~30 bits each, transform lengths up to `2^21`). Every
   NTT is exact integer arithmetic mod `p_i`, yielding `c_k mod p_i`.
2. **Sufficient modulus.** Primes are added until the reconstruction
   modulus `M = prod p_i` satisfies `M > 2B`. This is checked at runtime
   against the actual bound `B` computed from the inputs (and reported on
   stderr); the program aborts rather than truncates if the prime pool
   were ever insufficient.
3. **CRT reconstruction.** Garner's algorithm recovers the unique
   `x in [0, M)` with `x == c_k (mod M)`. Because `|c_k| <= B < M/2`,
   `c_k = x` when `x <= M/2` and `c_k = x - M` otherwise — the exact
   signed integer, printed in decimal via a custom big-integer type.

## Tests (CTest)

- `unit` (`tests/test_convolve.cpp`)
  - primitive-root / `2^21` root-of-unity self-check for every NTT prime;
  - 300 random short sequences (mixed full-range int64, small values, and
    `INT64_MAX`/`INT64_MIN` extremes) against an `O(n*m)` big-integer
    reference;
  - extreme-value cancellation: `[MAX,-MAX]*[MAX,MAX] = [MAX^2, 0, -MAX^2]`,
    `INT64_MIN^2 = 2^126`, long alternating runs cancelling to zero;
  - 100k + 100k all-ones smoke test at the maximum supported total length.
- `cli` (`tests/cli_test.sh`): end-to-end runs of the binary (file and
  stdin modes), exact expected outputs including extreme values, and
  rejection of malformed input.
