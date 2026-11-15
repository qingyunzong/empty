# dataeng

`dataeng` is a small, embeddable C++20 library that assembles MySQL row-based
binlog events into committed transactions.  It is transport agnostic: feed it
complete binlog event frames (header + body, including the checksum when the
stream uses CRC32) and it returns committed `Transaction` objects.

The implementation focuses on the parts a CDC pipeline needs to get right:

- `TABLE_MAP_EVENT` parsing, including column metadata, null bitmaps and
  optional MySQL 8 metadata (names, signedness, simple primary keys).
- `WRITE_ROWS` / `UPDATE_ROWS` / `DELETE_ROWS` v0, v1 and v2.
- **MINIMAL row images.**  A column omitted from an image is kept as
  `Cell::Unknown`; it is never turned into `Cell::Null`.  An explicit null bit
  produces `Cell::Null`.
- Table-id reuse.  Every table-map binding gets a monotonically increasing
  `generation`; each `RowChange` embeds an exact `TableMap` snapshot, so old
  rows remain unambiguous after `table_id` is reused.  Map scopes are reset at
  file rotation; generation numbers continue increasing.
- GTID, `BEGIN`/`COMMIT`/`ROLLBACK`, `XID`, DDL/autocommit statements, and
  `TRANSACTION_PAYLOAD_EVENT` (ZSTD or uncompressed).
- CRC32 validation and a **safe checkpoint**.  A validation failure never
  advances the checkpoint past the damage.  Transactions that completed before
  the failure remain deliverable.

## Build

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

Embed by compiling `dataeng.cpp` with your project, or link the `dataeng`
static library.  The only optional runtime dependency is `libzstd` for
compressed `TRANSACTION_PAYLOAD_EVENT`; it is loaded with `dlopen` and is not a
link-time dependency.

## Basic use

```cpp
#include "dataeng.hpp"

#include <span>
#include <vector>

dataeng::BinlogAssembler assembler;

// `event` is one complete event exactly as it appears in the binlog file.
// `file` is the binlog file name containing that event.
dataeng::FeedResult result = assembler.push_event(event, "mysql-bin.000042");

if (!result) {
  // result.error describes why the event was rejected.  result.checkpoint is
  // still the end of the last completely delivered transaction.
  std::cerr << result.error->to_string() << "\n";
} else {
  for (const dataeng::Transaction& txn : result.transactions) {
    for (const dataeng::RowChange& row : txn.changes) {
      const dataeng::RowImage& image = row.primary_image();
      for (std::size_t i = 0; i < image.size(); ++i) {
        if (image[i].is_unknown()) {
          // Not captured by this minimal image.  Do NOT write NULL.
        } else if (image[i].is_null()) {
          // Explicit SQL NULL.
        } else {
          use(image[i]);
        }
      }
    }
  }
}

// Safe resume point: end of the last completely delivered transaction.
dataeng::BinlogPosition resume = assembler.checkpoint();
```

`push_events()` accepts a concatenation of complete events.  It stops at the
first validation failure (by default) and still returns transactions that
completed earlier in the buffer.  `push_event()` requires exactly one event.

## Row images

`RowImage::columns` and `RowImage::present` always have the same length as the
table-map definition:

- `present[i] == false` -> `columns[i].is_unknown()` and the image contained no
  value for that column.
- `present[i] == true && columns[i].is_null()` -> the null bitmap explicitly
  marked the column as SQL `NULL`.
- `present[i] == true && columns[i].has_value()` -> decoded value.

For inserts `after` carries the new row and `before` is an all-unknown image of
the same width; deletes are the mirror image; updates carry both.  An
all-unknown image has `present[i] == false` everywhere.  `primary_image()`
selects the relevant image and `is_minimal()` reports whether any applicable
image omitted columns.

`Cell` distinguishes integers (`Signed`/`Unsigned`), floating point, decimal,
text, binary, bit, date/time/timestamp, enum/set and JSON/geometry.  Numeric
conversions are available through `as_signed()`, `as_unsigned()` and
`as_double()`; `to_string()` is intended for diagnostics.

## Table-id generations

MySQL may reuse a `table_id` for a different table after a table-map event.
`TableMap::generation` identifies each binding.  A `RowChange` stores the
complete map snapshot that was valid at the row event's file position, so it is
safe to buffer changes and process them later:

```cpp
// The current mapping may already point at another table, but the buffered
// change still has the original definition and generation.
const dataeng::TableMap& original = buffered_change.table;
```

Lookups by position are available through `table_map_at()` and
`table_map_generation()`.  Rotation clears the current file's table-id scope;
generation numbers keep increasing so a reused id is never mistaken for an old
generation.

## Checkpoints and failures

`last_position()` is the end of the last structurally valid event, while
`checkpoint()` is the safe resume point after all preceding transactions are
complete.  These are deliberately different:

- While a transaction is open, `last_position()` advances but `checkpoint()`
  does not.
- A checksum, table-map, row-image or nested-payload validation failure rejects
  the event and leaves `checkpoint()` at the last complete transaction.
- Setting `AssemblerOptions::stop_on_error = true` (the default) also poisons
  the stream: further pushes return `StreamPoisoned` until `recover()` or
  `reset()`.  This prevents a damaged event from being skipped silently.
- `FeedResult::position_advanced` reports whether the safe checkpoint moved
  during the call.  If a good transaction preceded a bad event in the same
  batch, the checkpoint moves only to that transaction's commit position.

`TRANSACTION_PAYLOAD_EVENT` is processed atomically.  Nested events are parsed
into the transaction; if any nested event fails, the inner commit and checkpoint
changes are rolled back before the error is reported.

## GTID and transaction payload

Transactions carry `Gtid` (`sid`, `gno`, logical timestamps when present),
database, row changes, statement events, XID and begin/commit positions.
`from_transaction_payload` is set for compressed/uncompressed payload
transactions.  If the XID sits outside the payload, the completed transaction's
commit position and XID are updated when the outer XID arrives.

## Limits

- The default parser is intentionally strict.  Unknown column types are
  rejected rather than guessed.
- Legacy (`MYSQL_TYPE_DECIMAL`) row values, partial-JSON
  `PARTIAL_UPDATE_ROWS_EVENT` semantics, and non-ZSTD payload compression are
  not decoded.
- The library is single-threaded per `BinlogAssembler`; use one instance per
  replication stream.
