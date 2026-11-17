package formal

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestManifestValidationRejectsIncompleteOrForeignLayouts(t *testing.T) {
	ref := ShardRef{Rank: 0, Key: ShardKey(1, 1, 0), Digest: Digest([]byte("x")), Size: 1}
	tests := []struct {
		name     string
		manifest Manifest
	}{
		{
			name:     "unsupported format",
			manifest: Manifest{Format: "v0", Step: 1, Generation: 1, RankCount: 1, Shards: []ShardRef{ref}},
		},
		{
			name:     "zero ranks",
			manifest: Manifest{Format: ManifestFormat, Step: 1, Generation: 1},
		},
		{
			name:     "rank count mismatch",
			manifest: Manifest{Format: ManifestFormat, Step: 1, Generation: 1, RankCount: 2, Shards: []ShardRef{ref}},
		},
		{
			name: "rank hole",
			manifest: Manifest{
				Format: ManifestFormat, Step: 1, Generation: 1, RankCount: 2,
				Shards: []ShardRef{ref, {Rank: 2, Key: ShardKey(1, 1, 2), Digest: ref.Digest, Size: 1}},
			},
		},
		{
			name: "key for different generation",
			manifest: Manifest{
				Format: ManifestFormat, Step: 1, Generation: 1, RankCount: 1,
				Shards: []ShardRef{{Rank: 0, Key: ShardKey(1, 2, 0), Digest: ref.Digest, Size: 1}},
			},
		},
		{
			name: "empty digest",
			manifest: Manifest{
				Format: ManifestFormat, Step: 1, Generation: 1, RankCount: 1,
				Shards: []ShardRef{{Rank: 0, Key: ShardKey(1, 1, 0), Size: 1}},
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.manifest.Validate(); !errors.Is(err, ErrManifestInvalid) {
				t.Fatalf("Validate: got %v, want ErrManifestInvalid", err)
			}
			data, err := tc.manifest.Marshal()
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			if _, err := DecodeManifest(data); !errors.Is(err, ErrManifestInvalid) {
				t.Fatalf("DecodeManifest: got %v, want ErrManifestInvalid", err)
			}
		})
	}
}

func TestVerifyDetectsMissingAndMismatchedShards(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(0)
	payload := []byte("only shard")
	const step, generation = 90, 2

	ref := uploadAll(t, store, step, generation, [][]byte{payload}, noRetry())[0]

	good := validManifest(step, generation, ref)
	if err := Verify(ctx, store, good, VerifyOptions{Retry: noRetry()}); err != nil {
		t.Fatalf("verify good manifest: %v", err)
	}

	wrongDigest := validManifest(step, generation, ShardRef{
		Rank:   ref.Rank,
		Key:    ref.Key,
		Digest: Digest([]byte("different payload")),
		Size:   ref.Size,
	})
	if err := Verify(ctx, store, wrongDigest, VerifyOptions{Retry: noRetry()}); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("verify wrong digest: got %v, want ErrDigestMismatch", err)
	}

	missingRef := ShardRef{
		Rank:   0,
		Key:    ShardKey(step, generation, 0),
		Digest: Digest(payload),
		Size:   int64(len(payload)),
	}
	missingRef.Key = ShardKey(step, generation+1, 0)
	// A key outside the expected layout is a structural error.
	if err := Verify(ctx, store, validManifest(step, generation, missingRef), VerifyOptions{Retry: noRetry()}); !errors.Is(err, ErrManifestInvalid) {
		t.Fatalf("verify foreign key: got %v, want ErrManifestInvalid", err)
	}

	// A structurally valid manifest whose shard was never written reports
	// not found after the retry budget is exhausted.
	absentStore := NewMemStore(0)
	if err := Verify(ctx, absentStore, good, VerifyOptions{Retry: noRetry()}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("verify absent shard: got %v, want ErrNotFound", err)
	}

	// A shard with the right key but the wrong header identity is rejected.
	foreignBlob, _, err := EncodeShard(step, generation+1, ref.Rank, payload)
	if err != nil {
		t.Fatalf("encode foreign shard: %v", err)
	}
	mismatchStore := NewMemStore(0)
	if _, err := mismatchStore.Put(ctx, ref.Key, foreignBlob, Condition{}); err != nil {
		t.Fatalf("put foreign shard: %v", err)
	}
	if err := Verify(ctx, mismatchStore, good, VerifyOptions{Retry: noRetry()}); !errors.Is(err, ErrShardMismatch) {
		t.Fatalf("verify foreign header: got %v, want ErrShardMismatch", err)
	}
}

func TestDecodeShardRejectsMalformedEnvelopes(t *testing.T) {
	blob, _, err := EncodeShard(1, 2, 3, []byte(strings.Repeat("payload", 20)))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	cases := map[string][]byte{
		"empty":        nil,
		"short prefix": blob[:7],
		"bad magic":    append([]byte("XXXX"), blob[4:]...),
		"header too big": func() []byte {
			out := append([]byte(nil), blob...)
			out[4], out[5], out[6], out[7] = 0xff, 0xff, 0xff, 0xff
			return out
		}(),
		"truncated payload": blob[:len(blob)-1],
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if _, _, err := DecodeShard(data); !errors.Is(err, ErrCorruptShard) {
				t.Fatalf("DecodeShard: got %v, want ErrCorruptShard", err)
			}
		})
	}
}

func TestVerifyStepRejectsManifestStoredUnderWrongStep(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(0)
	payload := []byte("payload")
	ref := uploadAll(t, store, 1, 1, [][]byte{payload}, noRetry())[0]
	data, err := validManifest(1, 1, ref).Marshal()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// Publish the step-1 manifest under the step-2 key.
	if _, err := store.Put(ctx, ManifestKey(2), data, Condition{}); err != nil {
		t.Fatalf("put manifest: %v", err)
	}
	if _, err := VerifyStep(ctx, store, 2, VerifyOptions{Retry: noRetry()}); !errors.Is(err, ErrManifestInvalid) {
		t.Fatalf("VerifyStep: got %v, want ErrManifestInvalid", err)
	}
}
