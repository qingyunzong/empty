# telemcodec

Bit-granular telemetry codec in pure Go (standard library only).

## Features

- **Bit order by input**: `MSBFirst` / `LSBFirst` select how stream bits map
  onto bytes (`bitorder.go`).
- **Signed widths**: `WriteSigned`/`ReadSigned` use two's complement with
  sign extension; out-of-range writes are rejected with `ErrOverflow` and
  the cursor does not advance (`writer.go`, `reader.go`).
- **Varints**: unsigned LEB128 and zigzag signed varints. Overlong
  (non-minimal) encodings and >64-bit values are rejected
  (`ErrOverlong`/`ErrOverflow`); on any failure the transaction cursor
  returns to where the read started.
- **Byte alignment**: `Align` pads/skips to the next byte boundary and
  reports the padding bit range.
- **Transactions**: `Mark`/`Rollback` on both reader and writer. Failed
  reads never advance the cursor; the reader caches bytes pulled from the
  underlying `io.Reader`, so rollback never loses cached external bytes.
- **Length references & nesting**: `Field.LenRef` + `Field.LenMul` derive a
  field's width from a previously decoded field (length multiplication);
  `KindStruct` nests sub-structures. A failed nested read rolls back both
  the cursor and the output sink (`descriptor.go`).
- **Pause/resume at any bit**: `BitReader.Snapshot`/`Resume` and
  `Session.Snapshot`/`ResumeSession` serialize the cursor, bit limit,
  cached bytes, and decoded values (so length references survive a pause)
  into a self-contained binary form (`state.go`, `session.go`).
- **Original bit ranges**: every decoded `Entry` carries its source range
  `[Start, End)`, including length-multiplied, sign-extended, and alignment
  entries. `Interpret` (`interpreter.go`) is an independent descriptor
  interpreter sharing no code with the codec; tests cross-check values and
  ranges between the two.

## Test results

`go test -count=1 ./...` (also verified with `-race`):

```
ok  	telemcodec	1.128s
```

17 tests, all PASS, including:

- `TestUnsignedRoundTripAndTruncation` / `TestSignedRoundTripOverflowAndTruncation`:
  enumerate widths 1..17, round-trip sample values, probe every truncation
  point, verify the cursor stays put on failure and reads recover after the
  limit is raised.
- `TestUvarintRejectsOverlongAndOverflow`: non-minimal encodings, 11-byte
  encodings, and 10th-byte overflow are rejected without cursor movement.
- `TestNestedFailureRollbackAndRecovery`: nested failure rolls back cursor
  and sink, cached source bytes are retained, and the same reader recovers
  once more bits are available.
- `TestPauseResumeAtAnyBit`: pause at every bit position of a mixed stream,
  serialize, resume, and re-encode to the exact original bytes.
- `TestRandomizedCrossCheck`: 500 random frames in both bit orders decoded
  by the codec and the independent interpreter must agree on every value
  and bit range, with ranges contiguously covering the stream.
