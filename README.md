# seqcheck

`seqcheck` verifies a packet log for per-stream **unique, in-order (prefix)
delivery** of sequence numbers:

- Each sequence number is delivered at most once per stream; retransmissions
  of an already-delivered sequence number are ignored (they are not new
  deliveries).
- Deliveries must form a gap-free prefix per stream: a packet that arrives
  ahead of a missing predecessor is a conflict.
- Streams are independent — no cross-stream ordering is assumed.
- Raw sequence numbers wrap modulo a (typically small) **modulus** and are
  mapped to monotonic extended numbers using a **window** around the
  next-expected position: a raw sequence number within `window` behind the
  expected position is a retransmission, within `window` ahead is a (gap)
  delivery attempt. A sequence number that fits neither is out of window.
  A tie (exactly `window` behind and ahead, possible when
  `2 * window == modulus`) resolves to the future, i.e. a gap.

On the first violation the CLI prints the conflict, its kind, and the
original packet evidence (log line number and raw line), then exits.

## Log format

One packet per line: `<stream> <seq>` (unsigned integers). Blank lines and
`#` comments are ignored.

## Usage

```
seqcheck [--modulus N] [--window N] [FILE]
```

`FILE` omitted or `-` reads standard input. Defaults: modulus 16, window 8.

Exit status: `0` log accepted, `1` first conflict reported, `2` usage/I/O
error.

```
$ printf '0 0\n0 1\n0 3\n' | seqcheck --modulus 8 --window 4
CONFLICT gap: line 3 stream 0 seq 3 (expected 2, modulus 8, window 4)
  detail: seq maps 1 ahead of next expected; prefix order violated
  packet: "0 3"
```

## Build and test

```
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

Tests (CTest):

- `unit_and_exhaustive` — unit tests for ordering, retransmission, wrap,
  cross-stream independence, window/tie handling, parsing, and conflict
  evidence; plus an **exhaustive small-window reference check**: for small
  modulus/window/stream counts, every possible log is enumerated and the
  checker's verdict (accept / first-conflict position / conflict kind /
  delivery and retransmission counts) is compared against an independently
  written reference implementation (`tests/test_checker.cpp`).
- `cli_*` — end-to-end CLI tests on fixture logs (`tests/logs/`), checking
  exit codes and output via `tests/cli_test.cmake`.

## Layout

- `src/checker.hpp`, `src/checker.cpp` — verification core and log parser
- `src/main.cpp` — CLI
- `tests/test_checker.cpp` — unit + exhaustive reference tests
- `tests/cli_test.cmake`, `tests/logs/` — CLI test driver and fixtures
