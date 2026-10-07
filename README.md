# seqcheck

Verify per-stream **unique, prefix-ordered delivery** from a packet log.

- Each stream must deliver sequence numbers as an exact prefix: 0, 1, 2, ...
- **Retransmissions do not count as new deliveries** — duplicates of already
  delivered sequence numbers are accepted and ignored.
- **Streams may interleave arbitrarily**; no cross-stream ordering is assumed.
- Raw sequence numbers wrap with a small **modulus** `M`; each packet is
  disambiguated to an absolute sequence number inside a **window** `W` around
  the next expected number (requires `2*W <= M` so the window holds at most
  one candidate per raw value).
- On failure the **first conflict** is reported with the original log line as
  evidence, plus the stream's expected sequence context.
- `--reference-check` cross-verifies the greedy checker against an exhaustive
  search over all legal delivery sequences (feasible for small `M`/`W`).

## Log format

One packet per line: `<stream_id> <seq>` (unsigned integers). Blank lines and
`#` comments are ignored.

```
1 0
2 0
1 1
1 1   # retransmission, ignored
2 1
```

## Build & test

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## Usage

```sh
seqcheck [--modulus M] [--window W] [--reference-check] <logfile|->
```

Exit codes: `0` no conflict, `1` conflict found, `2` usage/IO error.

Example conflict output:

```
CONFLICT line 7: prefix-order-violation: stream 1 seq 3 resolves to abs seq 3 but expected 2 (gap of 1)
evidence: line 7: "1 3"
context: stream 1 next expected abs seq 2 (raw 2 mod 4), window 0..3
stats before conflict: 6 packets, 5 delivered, 0 retransmissions, 2 stream(s)
```
