# kitting-allocator

Offline, single-node kitting reservation engine and CLI. Node.js 22+, standard
library only, tested with `node:test`.

## Domain

- **Batches**: `{ batchId, materialId, qty, expiresAt, status }` where `status`
  is `OK` or `HOLD`. Only `OK` stock can be reserved.
- **Substitutions**: `{ material, substitute }` means `substitute` may serve
  demand for `material`. Edges form a DAG; adding an edge that closes a cycle
  is rejected (`CYCLE`). Substitutability is transitive.
- **Orders**: `{ orderId, dueDate, lines: [{ lineId?, materialId, qty }] }`.
  Reservation priority is `dueDate`, then `orderId`, then line number. Within a
  line, stock is taken FEFO: `expiresAt`, then `batchId`.
- **Kitting**: an order is `OK` only when every line is fully reserved,
  otherwise `SHORT`. Lines keep partial reservations; the `shortages`
  certificate per short order reports the missing material, quantities, and
  `substitutesTried` (all materials reachable through the substitution graph).

## Allocation objective

Lines are processed in reservation order; each line takes as much as possible
from the earliest-expiring usable batch, then the next, and so on. This equals
the lexicographic optimum over all capacity-respecting assignments (line
sequence first, batch order second), which the test suite verifies against an
independent brute-force enumerator (`test/reference.test.js`).

Every mutation command recomputes reservations deterministically, so holding a
batch first shifts reservations within affected lines and only then marks
un-kittable orders `SHORT`; earlier orders (by dueDate/orderId) are never
preempted by later ones.

## CLI

```sh
node src/cli.js kit input.json commands.json -o out.json
```

- `input.json`: `{ "batches": [...], "orders": [...], "substitutions": [...] }`
  (all arrays optional).
- `commands.json`: an array of commands (or `{ "commands": [...] }`).
- `-o out.json`: report destination; omitted → report is printed to stdout.
- Exit codes: `0` success, `1` processing error (details on stderr), `2` usage
  error.

### Commands

| op | fields | notes |
| --- | --- | --- |
| `addOrder` | `order` | `DUPLICATE_ORDER` if id exists |
| `removeOrder` | `orderId` | `UNKNOWN_ORDER` |
| `addBatch` | `batch` | `DUPLICATE_BATCH` if id exists |
| `holdBatch` | `batchId` | freeze stock; `UNKNOWN_BATCH` |
| `releaseBatch` | `batchId` | release frozen stock |
| `consumeBatch` | `batchId`, `qty` | `OVER_CONSUME` if `qty` exceeds on-hand |
| `addSubstitution` | `material`, `substitute` | `CYCLE` / `DUPLICATE_SUBSTITUTION` |
| `removeSubstitution` | `material`, `substitute` | `UNKNOWN_SUBSTITUTION` |
| `undo` / `redo` | — | `EMPTY_UNDO` / `EMPTY_REDO` when stack is empty |

A failed command leaves the state untouched and is not undoable. Any new
mutation clears the redo stack.

## Report format

```json
{
  "orders": [
    {
      "orderId": "O1",
      "dueDate": "2026-03-01",
      "status": "SHORT",
      "lines": [
        { "lineId": "L1", "materialId": "A", "qty": 5, "reservedQty": 3,
          "missing": 2, "reservations": [{ "batchId": "A2", "qty": 3 }] }
      ],
      "shortages": [
        { "lineId": "L1", "materialId": "A", "required": 5, "reservedQty": 3,
          "missing": 2, "substitutesTried": ["B", "C"] }
      ]
    }
  ],
  "batches": [
    { "batchId": "A2", "materialId": "A", "qty": 3, "status": "OK",
      "expiresAt": "2026-02-01", "reservedQty": 3, "availableQty": 0 }
  ],
  "summary": { "totalOrders": 1, "shortOrders": 1, "totalBatches": 1, "heldBatches": 0 }
}
```

## Library

```js
import { KittingEngine, KittingError } from './src/engine.js';

const engine = new KittingEngine(input);
engine.applyCommand({ op: 'holdBatch', batchId: 'A1' });
const report = engine.report();
```

## Tests

```sh
node --test
```
