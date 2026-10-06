# jsonround

CLI and library for exact decimal rounding of JSON numbers. All arithmetic
is exact (`math/big`); no floating point is ever used.

## Features

- Parses JSON number literals into an exact decimal (mantissa + base-10
  exponent); the combined exponent must satisfy `|exp| <= 1000`, otherwise
  the literal is rejected with its input position preserved.
- Quantizes to a given number of decimal places with round-half-even
  (banker's rounding); negative zero always prints as `0`.
- Column mode: per-row deltas such that the sum of the first k rows equals
  round-half-even of the exact sum of the first k amounts. Withdrawing any
  row recomputes the deltas of all subsequent rows; values are stored in
  blocks with cached exact sums so only the affected suffix is rebuilt.

## Usage

```sh
echo '["1.005","2.675","-0.004","1e3"]' | jsonround -scale 2
# [100,268,0,100000]

echo '["0.5","0.5","0.5"]' | jsonround -scale 0 -cumul
# [0,1,1]

echo '["0.5","0.5","0.5"]' | jsonround -scale 0 -cumul -withdraw 0
# [0,1]
```

## Tests

```sh
go test ./...
```

Tests enumerate exact decimal half values and cross-check against a
rational reference, and compare chunked/random-withdrawal columns against
naive rational full accumulation.
