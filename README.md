# binpatch

Minimal-cost binary delta/patch tool (Python 3.11 standard library only).

## Usage

```
./delta source.bin target.bin patch.json   # write minimal-cost patch
./patch source.bin patch.json out.bin      # validate and apply patch
```

## Patch format

```json
{
  "source_sha256": "<hex>",
  "target_sha256": "<hex>",
  "ops": [
    {"lit": "<base64 of literal bytes>"},
    {"copy": [offset, length]}
  ]
}
```

Ops rebuild the target in order. `copy` references a non-empty,
in-bounds `[offset, offset+length)` range of the source; `lit` carries
literal bytes (base64).

## Cost model and tie-breaking

- Literal: 1 per byte. Copy: flat 2 per op.
- `delta` runs DP over target prefixes; a copy of length >= 1 is only
  allowed when the slice occurs in the source.
- Deterministic ties: a literal beats a break-even copy; among copies
  the smaller source offset wins, then the longer copy.

## Validation and exit codes

`patch` verifies the source hash, JSON structure, op types, literal
encoding/length, copy offset/length bounds, and the target hash. Any
failure (including invalid JSON) deletes the output file and exits 2;
success exits 0.

## Tests

```
python3.11 -m unittest discover -s tests -v
```

Includes an independent enumeration cross-check: for targets up to 10
bytes every split into ops is enumerated and compared against the DP
result for both cost and exact op sequence.
