# q216 — Ed25519 signed manifest component

An importable Go component for the collection-plugin update service. It
verifies signed root metadata and download manifests using Ed25519, with
TUF-style role keys and thresholds, RFC 8785 (JCS) canonical signing bytes
and injectable, atomically updated persistent state.

## Security model

- Ed25519 signatures over the RFC 8785 canonical JSON bytes of the
  `signed` payload; key IDs are `SHA-256` over the canonical key object.
- Root metadata declares the `root` and `targets` roles, each with its own
  public-key set and signature threshold. Unknown roles are rejected.
- Root rotation requires BOTH:
  - the old trusted root's `root` role threshold (old-root authorization), and
  - the candidate root's own `root` role threshold (new-root self-signature).
- Manifests (`targets`) are signed by the trusted root's targets role and
  carry monotonically increasing versions; rollback and replay are rejected.
- Each manifest target references an exact byte length and lowercase hex
  SHA-256 digest, both enforced when verifying downloaded content.
- Strict input handling: duplicate JSON keys, duplicate key IDs (including
  the same raw public key registered twice), duplicate signature key IDs,
  unknown JSON fields and unknown roles are all rejected.
- Expiry is exclusive: at the exact expiry instant the metadata is already
  invalid. An expired trusted root blocks all further operations.

## Persistence

The `Store` interface is injected, so any backend can be plugged in:

- `MemoryStore` — in-memory implementation, mainly for tests.
- `FileStore` — single JSON file written through a temp file, `fsync` and
  atomic `rename`, so the trusted root and accepted version never appear
  partially written.

Root and manifest-version records advance in a single `Save` call. A failed
verification or failed persistence never lowers an already accepted root or
manifest version.

## Usage

```go
store := q216.NewFileStore("/var/lib/dlks/state.json")
updater := q216.NewUpdater(store)

// One-time, out-of-band trust establishment.
if _, err := updater.Bootstrap(ctx, initialRootJSON); err != nil {
    return err
}

// Rotate roots (must satisfy both old and new root thresholds).
if _, err := updater.UpdateRoot(ctx, newRootJSON); err != nil {
    return err
}

// Accept a newer signed manifest.
manifest, err := updater.UpdateManifest(ctx, manifestJSON)
if err != nil {
    return err // versions only increase; rollbacks return ErrVersionRollback
}

// Verify downloaded bytes against the manifest references.
err = updater.VerifyTarget(ctx, manifestJSON, "plugins/acme", reader)
```

## Tests

Run `go test ./...` (add `-race` for the race detector). The suite covers
the required scenarios: insufficient old-root authorization, insufficient
new-root self-signature, the exact expiry instant, manifest rollback, and
failed updates preserving the accepted version, plus JCS canonicalization,
duplicate/unknown-field rejection, target length/hash mismatch and
file-backed atomic persistence.
