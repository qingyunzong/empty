# Correctly-Rounded Decimal Calculator

Pure Python 3.11+ standard library. No dependencies.

## Usage

```
python calc.py <expression> <precision> <mode>
```

- `expression`: arithmetic with `+ - * /`, parentheses, unary minus, and
  `sqrt(x)`. Numeric literals only.
- `precision`: number of significant decimal digits `p` (must be >= 1).
- `mode`: `HALF_EVEN`, `HALF_UP`, `DOWN` (toward zero), `FLOOR` (toward -inf).

Output: decimal string with exactly `p` significant digits (scientific
notation for very large/small exponents). Any error (invalid mode,
`p <= 0`, bad expression, division by zero, sqrt of negative) prints to
stderr and exits with code 2.

## Semantics

- `+ - * /` are evaluated exactly with `fractions.Fraction`; intermediate
  results are never truncated.
- `sqrt(x)` is correctly rounded to `p` significant digits using exact
  integer arithmetic (`math.isqrt` + exact tie comparison by squaring).
- The final result is correctly rounded to `p` significant digits.

## Examples

```
$ python calc.py "1/3" 10 HALF_UP
0.3333333333
$ python calc.py "2.5" 1 HALF_EVEN
2
$ python calc.py "-2.5" 1 FLOOR
-3
$ python calc.py "sqrt(2)" 50 HALF_EVEN
1.4142135623730950488016887242096980785696718753769
```

## Tests

```
python -m unittest discover -s tests -v
```
