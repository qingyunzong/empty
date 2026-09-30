# Supplier Selection Saga

Deterministic supplier-selection saga with crash recovery, cancellation
compensation, and idempotent side effects. Python 3.11+ standard library only.

## States

`QUOTING -> RESERVING -> COMPLETED | FAILED`, and
`QUOTING | RESERVING | COMPLETED --cancel--> CANCELING -> CANCELED`.

## Semantics

1. Quotes are collected for all suppliers (logically concurrently; `latency`
   is carried as data and does not change the deterministic event order);
   failed quotes are excluded.
2. Candidates are sorted by price ascending, ties by id ascending.
3. Reservations are attempted in candidate order; the first success becomes
   the final supplier, failures fall back to the next candidate.
4. No usable quotes -> `FAILED`.
5. Cancel before `RESERVING` reserves nothing; cancel after a reservation
   releases (compensates) the held supplier.
6. Every quote/reserve/release side effect is idempotent by request key
   (`<kind>:<saga-id>:<supplier-id>`). `crash --at EVENT` simulates a crash
   after the side effect is durable but before the journal commit; `recover`
   re-attempts the event and the idempotency key absorbs the duplicate, so
   no side effect ever executes twice (see `calls` in `state` output).

## Supplier input (JSON)

```json
[
  {"id": "A", "price": 20, "latency": 1, "quote_fails": false, "reserve_fails": false},
  {"id": "B", "price": 20, "latency": 5, "quote_fails": false, "reserve_fails": false},
  {"id": "C", "price": 10, "latency": 9, "quote_fails": true,  "reserve_fails": false}
]
```

## CLI

```sh
python3 saga.py --db state.json run --suppliers suppliers.json
python3 saga.py --db state.json crash --at quote:B      # also: reserve:A, release:A
python3 saga.py --db state.json recover
python3 saga.py --db state.json cancel
python3 saga.py --db state.json state
```

`crash` exits 1 on a simulated crash, 2 if the crash point was never reached.

## Tests

```sh
python3 -m unittest -v
```

Covers: reference candidate enumeration with expected state per event,
tie-price smallest-id selection, reserve fallback, cancel during quoting
(no reservation), cancel after reservation (compensation), all-quotes-fail,
all-reserves-fail, and crash/recover after quote and reserve events with
side-effect idempotency assertions. Latest honest run: `result.txt`.
