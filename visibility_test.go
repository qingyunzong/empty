package formal

import (
	"context"
	"errors"
	"testing"
)

func TestVisibilityDelayBlocksPrematurePublication(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(4)
	payloads := testPayloads(3)
	const step, generation = 50, 1

	uploadAll(t, store, step, generation, payloads, noRetry())

	_, err := (&Coordinator{
		Store: store, Step: step, Generation: generation, Ranks: len(payloads), Retry: noRetry(),
	}).Commit(ctx)
	if !errors.Is(err, ErrMissingShard) {
		t.Fatalf("commit while shards are invisible: got %v, want ErrMissingShard", err)
	}
	if _, err := store.Get(ctx, ManifestKey(step)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("manifest exists before all shards are visible: %v", err)
	}

	result := mustCommit(t, &Coordinator{
		Store: store, Step: step, Generation: generation, Ranks: len(payloads), Retry: tickRetry(store),
	})
	if !result.Created {
		t.Fatal("commit after visibility caught up did not create manifest")
	}
	mustVerifyStep(t, store, step, tickRetry(store))
}

func TestManifestReadsAreEventuallyVisible(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(3)
	payloads := testPayloads(2)
	const step, generation = 51, 2

	uploadAll(t, store, step, generation, payloads, tickRetry(store))
	result := mustCommit(t, &Coordinator{
		Store: store, Step: step, Generation: generation, Ranks: len(payloads), Retry: tickRetry(store),
	})

	if _, err := VerifyStep(ctx, store, step, VerifyOptions{Retry: noRetry()}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("immediately after publish: got %v, want ErrNotFound", err)
	}
	manifest := mustVerifyStep(t, store, step, tickRetry(store))
	if manifest.Generation != result.Manifest.Generation {
		t.Fatalf("verified generation %d, want %d", manifest.Generation, result.Manifest.Generation)
	}
}

func TestUploadReadbackRetriesUnderVisibilityDelay(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(3)
	payload := []byte("retried shard payload")
	uploader := &Uploader{Store: store, Step: 52, Generation: 6, Rank: 2, Retry: noRetry()}

	if _, err := uploader.Upload(ctx, payload); err != nil {
		t.Fatalf("first upload: %v", err)
	}

	// The retry hits create-once, then cannot read the existing object back
	// within the one-attempt budget.
	_, err := uploader.Upload(ctx, payload)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("retry before readback visibility: got %v, want ErrNotFound", err)
	}

	uploader.Retry = tickRetry(store)
	if _, err := uploader.Upload(ctx, payload); err != nil {
		t.Fatalf("retry after visibility: %v", err)
	}
	if _, err := uploader.Upload(ctx, []byte("conflicting payload")); !errors.Is(err, ErrShardConflict) {
		t.Fatalf("conflicting retry: got %v, want ErrShardConflict", err)
	}
}

func TestCoordinatorAdoptsInvisibleExistingManifest(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(5)
	payloads := testPayloads(2)
	const step, generation = 53, 3

	uploadAll(t, store, step, generation, payloads, tickRetry(store))
	first := mustCommit(t, &Coordinator{
		Store: store, Step: step, Generation: generation, Ranks: len(payloads), Retry: tickRetry(store),
	})

	second, err := (&Coordinator{
		Store: store, Step: step, Generation: generation, Ranks: len(payloads), Retry: tickRetry(store),
	}).Commit(ctx)
	if err != nil {
		t.Fatalf("second commit: %v", err)
	}
	if second.Created {
		t.Fatal("second commit republished manifest")
	}
	if second.Manifest.Generation != first.Manifest.Generation {
		t.Fatalf("second commit adopted generation %d, want %d", second.Manifest.Generation, first.Manifest.Generation)
	}

	if _, err := (&Coordinator{
		Store: store, Step: step, Generation: generation + 1, Ranks: len(payloads), Retry: tickRetry(store),
	}).Commit(ctx); !errors.Is(err, ErrStepCommitted) {
		t.Fatalf("newer generation: got %v, want ErrStepCommitted", err)
	}
	mustVerifyStep(t, store, step, tickRetry(store))
}
