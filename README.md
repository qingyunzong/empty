# rollsync

Binary delta sync: rolling Adler-32 weak checksum arbitrated by SHA-256.

## CLI

```sh
python -m rollsync delta OLD NEW --out PATCH   # build patch
python -m rollsync apply OLD PATCH --out OUT   # apply patch
```

Both subcommands print `copy_bytes=<n> literal_bytes=<m>` on stdout.

Exit codes: `0` ok, `2` usage/IO error, `5` corrupt/truncated patch,
`6` sha256 verification failure (target file is never written on failure).

## Design

- **Blocks**: OLD is split into fixed blocks whose size is a deterministic
  function of `len(OLD)` and `seed=17` (`ceil(len/17)`, clamped to
  [1, 64 KiB]); boundaries are therefore fixed by OLD size and seed.
- **Weak + strong**: NEW is scanned with a rolling Adler-32 window (at most
  64 KiB). Every weak hit is re-hashed with SHA-256; weak hits without a
  strong match are false hits (e.g. Adler collisions) and are rejected.
- **Overlap rule**: matches are taken by ascending NEW start, longest first
  (full block before the trailing partial block), first match wins.
- **Patch format**: 64-byte header (magic, seed, block size, OLD/NEW
  lengths, SHA-256 of NEW) + copy/literal ops + terminator. Each op carries
  its absolute NEW offset, so application is order-independent,
  deterministic, and replay-idempotent.
- **Safety**: `apply` reconstructs in memory, verifies SHA-256, and only
  then writes the target (atomically). Truncated patches exit 5, hash
  mismatches exit 6, and the target keeps its original bytes in both cases.

## Tests

```sh
python -m unittest discover -s tests -v
```

Covers: random round-trips (<=1 MB) cross-checked against a naive
longest-common-substring reference, a crafted Adler-32 collision
intercepted by SHA-256, empty/identical boundaries, truncated and
bit-flipped patches (exit codes 5/6, target preserved), op-order
independence, and replay idempotence. See `TEST_LOG.txt` for a real run.
