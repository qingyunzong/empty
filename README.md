# oven-control

Oven temperature-control instruction library + CLI. Exact rational arithmetic
only (BigInt); no floating point anywhere in the compute path.

## Library

```js
const { OvenController } = require('./src');

const controller = new OvenController(['0', '0', '1', '-2', '1']); // x^4 - 2x^3 + x^2
const r = controller.instruction('1/4', '3/4', 0);
// r.interval.min / r.interval.max  exact range over [lo, hi]
//   (endpoints + all rational stationary points, rational root theorem)
// r.value                          quantized to 10^-k, round half up
// r.errorBound                     max exact distance of any interval point to value
```

Throws coded errors: `E_AMBIGUOUS` (interval spans two ticks), `E_CONFIG`
(k < 0), `E_RATIONAL` (zero denominator / division by zero), `E_DEGREE`
(degree > 4), `E_TRANSACTION` (invalid undo/redo/commit).

## Transactions

```js
const tx = controller.beginTransaction();
tx.setCoefficient(0, '1/4');
tx.commit();        // validated first: invalid commits never touch the active version
controller.undo();  // restores the previous instruction
controller.redo();
```

## CLI

```
node src/cli.js quantize --coeffs 0,0,1,-2,1 --lo 1/4 --hi 3/4 --k 0
# {"interval":{"min":"9/256","max":"1/16"},"value":"0","errorBound":"1/16"}
```

Exit code 0 on success; 1 with `{"error":"E_*"}` on failure.

## Tests

```
node --test
```
