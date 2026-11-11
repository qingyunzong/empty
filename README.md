# q217

`q217` is a Go verifier for forward-only filter bytecode. It accepts at most
256 instructions and verifies every reachable one- or four-byte fixed-buffer
read before the program can be loaded.

## Bytecode

Each instruction is 16 bytes, little-endian:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | opcode |
| 1 | 1 | destination register |
| 2 | 1 | first source register |
| 3 | 1 | second source register |
| 4 | 8 | signed immediate or comparison operator |
| 12 | 2 | forward branch target PC |
| 14 | 2 | reserved, must be zero |

Supported operations are constant assignment, signed interval addition, six
conditional comparisons, one-byte loads, signed little-endian four-byte loads,
and return. Comparison targets must be later PCs, so programs cannot loop or
take a backward branch.

## Verification

`ValidateProgram` and `ValidateCode` propagate signed integer intervals:

- registers start uninitialized and any reachable uninitialized use is rejected;
- addition is rejected when either endpoint of its result interval can overflow;
- comparisons produce separately narrowed true and false edge states;
- multiple incoming edges are joined with the interval envelope;
- a read is accepted only when `[offset.Min, offset.Max]` is fully inside the
  fixed buffer for the read width;
- every accepted read receives a `ReadCertificate` containing its PC, width,
  buffer size, offset interval, and complete pre-read register state.

`VerifyCertificate` and `VerifyCodeCertificate` independently recompute the
whole fixed-point result and reject any certificate metadata or state mismatch.

The concrete `ExecuteProgram` and `ExecuteCode` interpreter is included for
testing and local execution. Tests exhaust every byte value for one-byte
buffers, exhaust a two-byte buffer for join precision, cover impossible
branches, and check four-byte boundary values.

## Usage

```go
certificate, err := q217.ValidateCode(code, registerCount, int64(len(buffer)))
if err != nil {
    return err
}
if err := q217.VerifyCodeCertificate(code, registerCount, int64(len(buffer)), certificate); err != nil {
    return err
}
result, err := q217.ExecuteCode(code, registerCount, buffer)
```

Run the checks with:

```sh
go test ./...
go vet ./...
```
