package formal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// ManifestFormat identifies the manifest format.
const ManifestFormat = "dlks.checkpoint.manifest/v1"

var (
	// ErrManifestInvalid reports a structurally invalid manifest.
	ErrManifestInvalid = errors.New("formal: invalid manifest")
	// ErrDigestMismatch reports a shard whose size or digest differs from the
	// value recorded in the published manifest.
	ErrDigestMismatch = errors.New("formal: shard digest mismatch")
)

// ShardRef is one immutable shard named by a manifest.
type ShardRef struct {
	Rank   int    `json:"rank"`
	Key    string `json:"key"`
	Digest string `json:"digest"`
	Size   int64  `json:"size"`
}

// Manifest is the commit record for one checkpoint step. RankCount and the
// contiguous rank list make a truncated manifest detectable.
type Manifest struct {
	Format     string     `json:"format"`
	Step       uint64     `json:"step"`
	Generation uint64     `json:"generation"`
	RankCount  int        `json:"rank_count"`
	Shards     []ShardRef `json:"shards"`
}

// Marshal encodes a manifest deterministically. The struct has no maps, so
// equal manifests always produce equal bytes, which makes stored manifests
// reproducible and easy to compare.
func (m Manifest) Marshal() ([]byte, error) {
	data, err := json.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("formal: encode manifest: %w", err)
	}
	return data, nil
}

// DecodeManifest parses and structurally validates a manifest.
func DecodeManifest(data []byte) (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return Manifest{}, fmt.Errorf("%w: decode: %w", ErrManifestInvalid, err)
	}
	if err := m.Validate(); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

// Validate checks that the manifest is complete and self-consistent.
func (m Manifest) Validate() error {
	if m.Format != ManifestFormat {
		return fmt.Errorf("%w: unsupported format %q", ErrManifestInvalid, m.Format)
	}
	if m.RankCount <= 0 {
		return fmt.Errorf("%w: rank count must be positive, got %d", ErrManifestInvalid, m.RankCount)
	}
	if len(m.Shards) != m.RankCount {
		return fmt.Errorf("%w: rank count %d but %d shards", ErrManifestInvalid, m.RankCount, len(m.Shards))
	}
	for i, ref := range m.Shards {
		if ref.Rank != i {
			return fmt.Errorf("%w: shard at position %d has rank %d", ErrManifestInvalid, i, ref.Rank)
		}
		wantKey := ShardKey(m.Step, m.Generation, ref.Rank)
		if ref.Key != wantKey {
			return fmt.Errorf("%w: rank %d key %q, want %q", ErrManifestInvalid, ref.Rank, ref.Key, wantKey)
		}
		if ref.Digest == "" {
			return fmt.Errorf("%w: rank %d has empty digest", ErrManifestInvalid, ref.Rank)
		}
		if ref.Size < 0 {
			return fmt.Errorf("%w: rank %d has negative size %d", ErrManifestInvalid, ref.Rank, ref.Size)
		}
	}
	return nil
}

// VerifyOptions controls read retries while checking a manifest.
type VerifyOptions struct {
	Retry RetryPolicy
}

// Verify checks that every shard named by the manifest exists, belongs to the
// manifest's step and generation, and still has the recorded digest and size.
// Missing shards are retried according to opts.Retry because object-store
// reads may be eventually consistent.
func Verify(ctx context.Context, store Store, m Manifest, opts VerifyOptions) error {
	if store == nil {
		return errors.New("formal: nil store")
	}
	if err := m.Validate(); err != nil {
		return err
	}
	for _, ref := range m.Shards {
		obj, err := getWithRetry(ctx, store, ref.Key, opts.Retry)
		if err != nil {
			return fmt.Errorf("formal: verify rank %d: %w", ref.Rank, err)
		}
		header, _, err := DecodeShard(obj.Data)
		if err != nil {
			return fmt.Errorf("formal: verify rank %d: %w", ref.Rank, err)
		}
		if header.Step != m.Step || header.Generation != m.Generation || header.Rank != ref.Rank {
			return fmt.Errorf("%w: rank %d header step=%d generation=%d rank=%d, manifest step=%d generation=%d rank=%d",
				ErrShardMismatch, ref.Rank, header.Step, header.Generation, header.Rank, m.Step, m.Generation, ref.Rank)
		}
		if header.Digest != ref.Digest || header.Size != ref.Size {
			return fmt.Errorf("%w: rank %d manifest digest=%s size=%d, object digest=%s size=%d",
				ErrDigestMismatch, ref.Rank, ref.Digest, ref.Size, header.Digest, header.Size)
		}
	}
	return nil
}

// VerifyStep loads the manifest for step and verifies all of its shards.
func VerifyStep(ctx context.Context, store Store, step uint64, opts VerifyOptions) (Manifest, error) {
	if store == nil {
		return Manifest{}, errors.New("formal: nil store")
	}
	obj, err := getWithRetry(ctx, store, ManifestKey(step), opts.Retry)
	if err != nil {
		return Manifest{}, fmt.Errorf("formal: load manifest for step %d: %w", step, err)
	}
	m, err := DecodeManifest(obj.Data)
	if err != nil {
		return Manifest{}, fmt.Errorf("formal: manifest for step %d: %w", step, err)
	}
	if m.Step != step {
		return Manifest{}, fmt.Errorf("%w: manifest for step %d found at key for step %d", ErrManifestInvalid, m.Step, step)
	}
	if err := Verify(ctx, store, m, opts); err != nil {
		return Manifest{}, fmt.Errorf("formal: manifest for step %d: %w", step, err)
	}
	return m, nil
}
