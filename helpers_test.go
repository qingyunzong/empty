package formal

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func testPayloads(n int) [][]byte {
	payloads := make([][]byte, n)
	for rank := range payloads {
		payloads[rank] = []byte(fmt.Sprintf(
			"checkpoint-payload/rank=%03d/%s",
			rank,
			strings.Repeat(fmt.Sprintf("%d", rank%10), 96),
		))
	}
	return payloads
}

func uploadAll(t *testing.T, store Store, step, generation uint64, payloads [][]byte, policy RetryPolicy) []ShardRef {
	t.Helper()
	refs := make([]ShardRef, len(payloads))
	for rank, payload := range payloads {
		uploader := &Uploader{
			Store:      store,
			Step:       step,
			Generation: generation,
			Rank:       rank,
			Retry:      policy,
		}
		ref, err := uploader.Upload(context.Background(), payload)
		if err != nil {
			t.Fatalf("upload rank %d: %v", rank, err)
		}
		refs[rank] = ref
	}
	return refs
}

func mustCommit(t *testing.T, coordinator *Coordinator) CommitResult {
	t.Helper()
	result, err := coordinator.Commit(context.Background())
	if err != nil {
		t.Fatalf("commit step %d generation %d: %v", coordinator.Step, coordinator.Generation, err)
	}
	return result
}

func mustVerifyStep(t *testing.T, store Store, step uint64, policy RetryPolicy) Manifest {
	t.Helper()
	manifest, err := VerifyStep(context.Background(), store, step, VerifyOptions{Retry: policy})
	if err != nil {
		t.Fatalf("verify step %d: %v", step, err)
	}
	return manifest
}

func noRetry() RetryPolicy {
	return RetryPolicy{Attempts: 1}
}

// tickRetry advances the simulated store clock instead of sleeping, so
// visibility tests are deterministic and fast.
func tickRetry(store *MemStore) RetryPolicy {
	return RetryPolicy{
		Attempts: 256,
		Poll: func(ctx context.Context, _ int) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			store.Advance(1)
			return nil
		},
	}
}

func validManifest(step, generation uint64, refs ...ShardRef) Manifest {
	return Manifest{
		Format:     ManifestFormat,
		Step:       step,
		Generation: generation,
		RankCount:  len(refs),
		Shards:     refs,
	}
}
