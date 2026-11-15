# dataeng — embeddable WARC assembly

`dataeng` is a dependency-free C++20 library for assembling WARC 1.0/1.1
records into request/response exchanges. It is intended to be linked directly
into a web archiver instead of shelling out to a separate WARC tool.

> 中文摘要：本库按 `WARC-Record-ID`、`WARC-Concurrent-To` 和分段来源字段组装
> request/response/revisit/metadata/continuation。分段记录会校验序号、总长度和
> 摘要；revisit 只能解析到归档中已知且完整的载荷。缺链会进入
> `missing_links`/`repairs` 清单，库不会补造请求、响应、分段或载荷。

The library:

- parses WARC records with case-insensitive headers and optional LF line endings;
- normalizes `WARC-Record-ID` values and pairs records through
  `WARC-Concurrent-To`, `WARC-Refers-To`, and `WARC-Segment-Origin-ID`;
- groups continuation segments, reorders them by `WARC-Segment-Number`, and
  validates `WARC-Segment-Total-Length` against the concatenated blocks;
- verifies `WARC-Block-Digest` and `WARC-Payload-Digest` for SHA-1, SHA-256, and
  MD5, accepting WARC base32 or hexadecimal encodings;
- resolves a revisit only against an already-known, complete payload record;
- emits a deterministic missing-link/repair checklist instead of inventing a
  request, response, segment, or payload.

## Build and test

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

The build produces `libdataeng.a`, the `warc-assemble` inspection tool, and the
self-contained `dataeng_tests` test binary.

## Embedding

```cpp
#include "dataeng.hpp"

dataeng::Assembly assembly = dataeng::assemble(warc_bytes);

if (!assembly.ok()) {
    // Structural, digest, length, or reference errors.
}

for (const dataeng::Exchange& exchange : assembly.exchanges) {
    if (!exchange.complete) {
        // exchange.missing and exchange.repairs explain exactly what is absent.
        continue;
    }
    if (exchange.response) {
        const dataeng::LogicalRecord& response =
            assembly.logical_records[*exchange.response];
        // response.payload is the HTTP entity body. response.block is the
        // complete block, including HTTP headers for response/request records.
    } else if (exchange.revisit) {
        const dataeng::LogicalRecord& revisit =
            assembly.logical_records[*exchange.revisit];
        // revisit.revisit_target names the logical record with the known
        // payload; the payload is intentionally not copied into the revisit.
    }
}

for (const dataeng::RepairAction& action : assembly.repairs) {
    // action.code, action.record_id, action.missing_id, action.action
}
```

Separate parse and assemble steps are available when records arrive
incrementally or from several files:

```cpp
dataeng::ParseResult parsed = dataeng::parse_warc(bytes);
dataeng::Assembly assembly =
    dataeng::assemble(std::move(parsed.records), options);
```

`ParseResult::diagnostics` contains framing errors. When the string/stream
overload of `assemble()` is used, framing diagnostics are kept in
`Assembly::parse_diagnostics`.

## Command line

```sh
warc-assemble archive.warc                 # human-readable summary
warc-assemble --json archive.warc          # complete machine-readable report
warc-assemble --check archive.warc         # diagnostics only
warc-assemble --repairs archive.warc       # repair checklist
warc-assemble --repairs --json archive.warc
```

Exit status is `0` when every exchange is complete and no error remains, `1`
for usage/I/O failures, and `2` for invalid or incomplete archives. Several
input files are parsed into one assembly, so records may be paired across file
boundaries. With no file argument, input is read from standard input.

Useful options:

- `--require-digest` requires a block or payload digest on every logical record.
- `--no-digest-check` disables digest verification.
- `--allow-missing-request` stops treating a response/revisit without a request
  as incomplete.
- `--parse-only` stops after WARC framing.
- `--strict` makes warnings affect the exit status.
- `-o FILE`, `--output FILE` writes the report to a file.

## Pairing rules

- Physical records are grouped into logical records by a unique head record id.
  A continuation attaches through `WARC-Segment-Origin-ID`.
- If a continuation omits `WARC-Segment-Origin-ID`, exactly one
  `WARC-Concurrent-To` naming a unique head is accepted as a compatibility
  fallback and reported as a warning.
- Segment order is determined by `WARC-Segment-Number`, not physical order.
- `WARC-Concurrent-To` is treated as an undirected association for grouping:
  either the request or the response may carry the link. Repeated headers and
  whitespace/comma-separated id lists are supported.
- A metadata record without `WARC-Concurrent-To` may attach through
  `WARC-Refers-To`.
- Every connected component with one response or revisit root becomes one
  exchange. Multiple roots in one component are reported as ambiguous; the
  library does not merge them into a fabricated capture.
- A response without a request remains a real, incomplete exchange. A request
  whose referenced response is absent is listed as unpaired and produces no
  fabricated exchange.

## Segment and digest checks

For a segmented logical record the library verifies:

- every physical record's `Content-Length` against the parsed body;
- contiguous, unique segment numbers starting at 1;
- the sum of segment block lengths against `WARC-Segment-Total-Length`;
- every supplied block/payload digest. Segment-local and combined-block
  interpretations are accepted, but arbitrary digest values are not.

A payload digest is checked against the HTTP entity body (bytes after the HTTP
header terminator) for response/request/revisit records; it is never satisfied
by the block digest of the HTTP headers plus body.

Records carrying `WARC-Truncated` are kept but marked incomplete; they cannot
serve as the known payload of a revisit.

## Revisit policy

A revisit is resolved in this order:

1. `WARC-Refers-To` (record id);
2. `WARC-Refers-To-Target-URI` plus `WARC-Refers-To-Date`;
3. a unique known payload matching `WARC-Payload-Digest`.

The final target must be a complete response/resource (revisit chains may be
followed, with cycle detection). The revisit's declared payload digest is
checked against that target. The target payload is never copied into the
revisit, and an unresolved revisit remains unresolved. Unknown, ambiguous, or
payload-less targets produce `revisit_target_*` diagnostics and repairs.

## No fabricated exchanges

The library never creates a record body, record id, request, response, or
payload to fill a gap. It reports only records that were actually supplied:

- `Assembly::missing_links` is the machine-readable gap list;
- `Assembly::repairs` is the actionable checklist (what to fetch, correct, or
  re-export);
- `Exchange::complete` is false whenever a required record is absent;
- `Assembly::complete()` is true only when every logical record is complete and
  every exchange is complete.

This makes a partially captured archive safe to inspect and repair without
silently presenting an invented exchange as complete.

## Limits

- WARC digests support SHA-1, SHA-256, and MD5. Other algorithms are reported as
  unsupported rather than ignored.
- HTTP framing is recognized for `application/http` records and for plausible
  HTTP request/status lines; HTTP/2 frame parsing is not attempted.
- The parser does not decompress transfer/content encodings; digests are checked
  against the bytes stored in the WARC block.
