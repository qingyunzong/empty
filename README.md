# forward

`forward` copies a chunked request body from one upstream source to many
destination sinks, enforcing a byte budget with strict terminal-state
semantics.

## Semantics

- **Chunked read**: the body is pulled block by block via `Source.ReadChunk`;
  a zero-length block is a valid empty chunk, only `io.EOF` ends the body.
- **Byte limit**: the moment the body grows past `Forwarder.MaxBytes`,
  publishing stops, the upstream is closed, all in-flight writes are awaited,
  and only then are the sinks terminated. A partially sent prefix is never
  reported as `Delivered`.
- **Error taxonomy**: `ErrLimitExceeded` (limit), `*ReadFailure` (upstream
  read error, with byte offset), `*SinkFailure` (destination write error,
  with sink index and offset), and `ctx.Err()` (cancel) are distinguishable
  via `errors.Is` / `errors.As`.
- **Shared leases**: every destination holds its own lease on the same
  underlying block; the block returns to the pool only after the publisher
  and all destinations release, so any unreleased lease prevents reuse.
- **Unique terminal state**: each sink is closed exactly once per `Forward`;
  the main response and cancellation race for the outcome and whichever
  lands first is never overwritten.

## Test

```sh
go test ./...
```

The tests use scripted read ends and recording write ends to enumerate
error-injection positions and verify byte accounting, a barrier helper to
check the budget and the unique-terminal-state invariants, and a race loop
for delivery-vs-cancel.
