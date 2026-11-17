package formal

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestCommitPublishesVerifiedManifest(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(0)
	payloads := testPayloads(4)
	const step, generation = 42, 7

	refs := uploadAll(t, store, step, generation, payloads, noRetry())
	result := mustCommit(t, &Coordinator{
		Store:      store,
		Step:       step,
		Generation: generation,
		Ranks:      len(payloads),
		Retry:      noRetry(),
	})

	if !result.Created {
		t.Fatal("first commit was not marked created")
	}
	if result.Manifest.Step != step || result.Manifest.Generation != generation {
		t.Fatalf("manifest identity = (%d,%d)", result.Manifest.Step, result.Manifest.Generation)
	}
	if result.Manifest.RankCount != len(payloads) || len(result.Manifest.Shards) != len(payloads) {
		t.Fatalf("manifest has %d/%d shards, want %d", result.Manifest.RankCount, len(result.Manifest.Shards), len(payloads))
	}
	if !reflect.DeepEqual(result.Manifest.Shards, refs) {
		t.Fatalf("manifest shards\n got: %#v\nwant: %#v", result.Manifest.Shards, refs)
	}

	verified := mustVerifyStep(t, store, step, noRetry())
	if !reflect.DeepEqual(verified, result.Manifest) {
		t.Fatalf("verified manifest differs from returned manifest")
	}

	obj, err := store.Get(ctx, ManifestKey(step))
	if err != nil {
		t.Fatalf("read manifest object: %v", err)
	}
	stored, err := DecodeManifest(obj.Data)
	if err != nil {
		t.Fatalf("decode stored manifest: %v", err)
	}
	if !reflect.DeepEqual(stored, result.Manifest) {
		t.Fatalf("stored manifest differs from returned manifest")
	}
}

func TestUploadIsIdempotentForIdenticalRetry(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(0)
	payload := []byte("rank zero checkpoint bytes")
	uploader := &Uploader{Store: store, Step: 3, Generation: 9, Rank: 0, Retry: noRetry()}

	first, err := uploader.Upload(ctx, payload)
	if err != nil {
		t.Fatalf("first upload: %v", err)
	}
	before, err := store.Get(ctx, first.Key)
	if err != nil {
		t.Fatalf("get after first upload: %v", err)
	}

	second, err := uploader.Upload(ctx, payload)
	if err != nil {
		t.Fatalf("retry upload: %v", err)
	}
	if first != second {
		t.Fatalf("retry returned %#v, want %#v", second, first)
	}
	after, err := store.Get(ctx, first.Key)
	if err != nil {
		t.Fatalf("get after retry: %v", err)
	}
	if before.Version != after.Version {
		t.Fatalf("retry rewrote immutable object: version %q -> %q", before.Version, after.Version)
	}
}

func TestUploadRejectsDifferentContentUnderSameGeneration(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(0)
	payload := []byte("the shard chosen for this generation")
	replacement := []byte("a different shard for the same rank")
	uploader := &Uploader{Store: store, Step: 5, Generation: 2, Rank: 0, Retry: noRetry()}

	first, err := uploader.Upload(ctx, payload)
	if err != nil {
		t.Fatalf("first upload: %v", err)
	}
	_, err = uploader.Upload(ctx, replacement)
	if !errors.Is(err, ErrShardConflict) {
		t.Fatalf("overwrite attempt: got %v, want ErrShardConflict", err)
	}

	obj, err := store.Get(ctx, first.Key)
	if err != nil {
		t.Fatalf("get shard: %v", err)
	}
	header, body, err := DecodeShard(obj.Data)
	if err != nil {
		t.Fatalf("decode shard: %v", err)
	}
	if string(body) != string(payload) || header.Digest != Digest(payload) {
		t.Fatalf("conflicting upload changed stored shard")
	}

	result := mustCommit(t, &Coordinator{
		Store: store, Step: 5, Generation: 2, Ranks: 1, Retry: noRetry(),
	})
	if result.Manifest.Shards[0].Digest != Digest(payload) {
		t.Fatalf("manifest digest = %s, want original %s", result.Manifest.Shards[0].Digest, Digest(payload))
	}
}

func TestLateOldRanksCannotChangeCommittedStep(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(0)
	payloads := testPayloads(3)
	const step, generation = 20, 3

	uploadAll(t, store, step, generation, payloads, noRetry())
	first := mustCommit(t, &Coordinator{
		Store: store, Step: step, Generation: generation, Ranks: len(payloads), Retry: noRetry(),
	})
	if !first.Created {
		t.Fatal("expected initial commit to create manifest")
	}
	before, err := store.Get(ctx, ManifestKey(step))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}

	// A rank from an older step arrives late.
	if _, err := (&Uploader{
		Store: store, Step: step - 1, Generation: generation - 1, Rank: 0, Retry: noRetry(),
	}).Upload(ctx, []byte("late shard from an older step")); err != nil {
		t.Fatalf("late old-step upload: %v", err)
	}
	// A rank from an older generation of the same step arrives late.
	if _, err := (&Uploader{
		Store: store, Step: step, Generation: generation - 1, Rank: 0, Retry: noRetry(),
	}).Upload(ctx, []byte("late shard from an older generation")); err != nil {
		t.Fatalf("late old-generation upload: %v", err)
	}

	second := mustCommit(t, &Coordinator{
		Store: store, Step: step, Generation: generation, Ranks: len(payloads), Retry: noRetry(),
	})
	if second.Created {
		t.Fatal("retry republished an existing step")
	}
	if !reflect.DeepEqual(second.Manifest, first.Manifest) {
		t.Fatal("retry returned a different manifest")
	}

	after, err := store.Get(ctx, ManifestKey(step))
	if err != nil {
		t.Fatalf("read manifest after late uploads: %v", err)
	}
	if !bytes.Equal(before.Data, after.Data) {
		t.Fatal("late uploads changed the published manifest")
	}

	verified := mustVerifyStep(t, store, step, noRetry())
	for _, ref := range verified.Shards {
		header, _, err := DecodeShard(mustGet(t, store, ref.Key).Data)
		if err != nil {
			t.Fatalf("decode shard %s: %v", ref.Key, err)
		}
		if header.Step != step || header.Generation != generation {
			t.Fatalf("manifest mixes step/generation: %s has (%d,%d)", ref.Key, header.Step, header.Generation)
		}
	}

	// A newer generation of an already-committed step must not replace it.
	result, err := (&Coordinator{
		Store: store, Step: step, Generation: generation + 1, Ranks: len(payloads), Retry: noRetry(),
	}).Commit(ctx)
	if !errors.Is(err, ErrStepCommitted) {
		t.Fatalf("newer generation commit: got %v, want ErrStepCommitted", err)
	}
	if result.Manifest.Generation != generation {
		t.Fatalf("StepCommittedError reports generation %d, want %d", result.Manifest.Generation, generation)
	}
}

func TestCommitRejectsShardFromAnotherStep(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(0)
	payloads := testPayloads(3)
	const step, generation = 11, 4

	uploadAll(t, store, step, generation, payloads[:2], noRetry())
	foreign, _, err := EncodeShard(step+1, generation, 2, payloads[2])
	if err != nil {
		t.Fatalf("encode foreign shard: %v", err)
	}
	if _, err := store.Put(ctx, ShardKey(step, generation, 2), foreign, Condition{IfNoneMatch: true}); err != nil {
		t.Fatalf("place foreign shard: %v", err)
	}

	_, err = (&Coordinator{
		Store: store, Step: step, Generation: generation, Ranks: len(payloads), Retry: noRetry(),
	}).Commit(ctx)
	if !errors.Is(err, ErrShardMismatch) {
		t.Fatalf("commit: got %v, want ErrShardMismatch", err)
	}
	if _, err := store.Get(ctx, ManifestKey(step)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("manifest was published despite foreign shard: %v", err)
	}
}

func TestCommitRejectsCorruptShard(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(0)
	payloads := testPayloads(2)
	const step, generation = 12, 4

	uploadAll(t, store, step, generation, payloads[:1], noRetry())
	blob, _, err := EncodeShard(step, generation, 1, payloads[1])
	if err != nil {
		t.Fatalf("encode shard: %v", err)
	}
	blob[len(blob)-1] ^= 0xff
	if _, err := store.Put(ctx, ShardKey(step, generation, 1), blob, Condition{IfNoneMatch: true}); err != nil {
		t.Fatalf("place corrupt shard: %v", err)
	}

	_, err = (&Coordinator{
		Store: store, Step: step, Generation: generation, Ranks: 2, Retry: noRetry(),
	}).Commit(ctx)
	if !errors.Is(err, ErrCorruptShard) {
		t.Fatalf("commit: got %v, want ErrCorruptShard", err)
	}
	if _, err := store.Get(ctx, ManifestKey(step)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("manifest was published despite corrupt shard: %v", err)
	}
}

func TestVerifyDetectsOverwriteAfterPublication(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(0)
	payloads := testPayloads(2)
	const step, generation = 30, 8

	uploadAll(t, store, step, generation, payloads, noRetry())
	mustCommit(t, &Coordinator{
		Store: store, Step: step, Generation: generation, Ranks: len(payloads), Retry: noRetry(),
	})
	mustVerifyStep(t, store, step, noRetry())

	// Simulate a rogue unconditional overwrite of an already-published shard.
	replacement, _, err := EncodeShard(step, generation, 0, []byte("rogue replacement payload"))
	if err != nil {
		t.Fatalf("encode replacement: %v", err)
	}
	if _, err := store.Put(ctx, ShardKey(step, generation, 0), replacement, Condition{}); err != nil {
		t.Fatalf("overwrite shard: %v", err)
	}

	if _, err := VerifyStep(ctx, store, step, VerifyOptions{Retry: noRetry()}); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("verify after overwrite: got %v, want ErrDigestMismatch", err)
	}
	if _, err := (&Coordinator{
		Store: store, Step: step, Generation: generation, Ranks: len(payloads), Retry: noRetry(),
	}).Commit(ctx); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("commit retry after overwrite: got %v, want ErrDigestMismatch", err)
	}
}

func mustGet(t *testing.T, store Store, key string) Object {
	t.Helper()
	obj, err := store.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("get %s: %v", key, err)
	}
	return obj
}
