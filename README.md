# waldb

A tiny write-ahead-log key-value store in pure Python 3.11+ stdlib.

## Format

- Header: `u64` generation (little-endian).
- Frame: `u32 length`, `u32 crc32`, `u8 type`, payload.
  `length`/`crc32` cover the type byte plus payload.
- Types: `PUT=1` (`u32 klen, key, u32 vlen, value`), `DEL=2`
  (`u32 klen, key`), `COMMIT=3` (no payload).
- Keys and values are UTF-8 strings.

## Write protocol

1. append all data frames of the transaction
2. `flush` + `os.fsync`
3. append the `COMMIT` frame
4. `flush` + `os.fsync`

## Recovery

`recover` scans frames from the end of the header and stops at the first
frame with a bad length or crc, truncating the file to the end of the
last complete `COMMIT` frame. Incomplete transactions are discarded;
transactions committed before the corruption survive. A damaged header
(fewer than 8 bytes) resets the database to empty. Each recovery bumps
the header generation.

## CLI

```
python waldb.py put k v [--db PATH]
python waldb.py del k [--db PATH]
python waldb.py get k [--db PATH]
python waldb.py recover [--db PATH]
python waldb.py dump [--db PATH]
```

All errors (missing key, corrupt header, bad usage, I/O failure) exit
with status 5.

## Tests

```
python -m unittest discover -s tests -v
```
