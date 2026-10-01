# delta / patch

Minimal-cost binary diff tools (Python 3.11+ standard library only).

## Usage

```
python3 delta.py source.bin target.bin patch.json
python3 patch.py source.bin patch.json out.bin
```

## Patch format

```json
{
  "source_sha256": "<hex>",
  "target_sha256": "<hex>",
  "ops": [ {"lit": "<base64>"}, {"copy": [offset, length]} ]
}
```

`copy` references a valid in-bounds range of the source; `lit` carries
literal bytes. Replaying the ops in order rebuilds the target.

## Cost model and determinism

- Literal byte: cost 1. Copy op: flat cost 2 (only used for length >= 1
  substrings that occur in the source).
- `delta` runs a DP over every target prefix to minimise total cost.
- Ties are broken deterministically: a literal is kept over an equal-cost
  copy; among equal-cost copies the smaller source offset wins, then the
  longer copy.

## Verification

`patch` verifies the source hash, op types, copy offsets/lengths and the
target hash. Any mismatch or invalid JSON deletes the output file and
exits with code 2; success exits 0.

## Tests

```
python3 -m unittest -v test_delta_patch
```

Includes an independent brute-force enumeration cross-check of cost and
ops for all targets up to 10 bytes across fixed and seeded-random cases.
Latest real run is recorded in `result.txt`.
