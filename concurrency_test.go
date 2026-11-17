package formal

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
)

type commitOutcome struct {
	result CommitResult
	err    error
}

func TestConcurrentCoordinatorsSameGenerationPublishOnce(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(0)
	payloads := testPayloads(5)
	const step, generation = 60, 1
	uploadAll(t, store, step, generation, payloads, noRetry())

	const workers = 8
	start := make(chan struct{})
	outcomes := make(chan commitOutcome, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			result, err := (&Coordinator{
				Store: store, Step: step, Generation: generation, Ranks: len(payloads), Retry: noRetry(),
			}).Commit(ctx)
			outcomes <- commitOutcome{result: result, err: err}
		}()
	}
	close(start)
	wg.Wait()
	close(outcomes)

	created := 0
	var manifest Manifest
	for outcome := range outcomes {
		if outcome.err != nil {
			t.Fatalf("concurrent commit: %v", outcome.err)
		}
		if outcome.result.Created {
			created++
		}
		if manifest.Format == "" {
			manifest = outcome.result.Manifest
		} else if !reflect.DeepEqual(manifest, outcome.result.Manifest) {
			t.Fatal("concurrent coordinators returned different manifests")
		}
	}
	if created != 1 {
		t.Fatalf("%d coordinators created the manifest, want exactly 1", created)
	}
	if verified := mustVerifyStep(t, store, step, noRetry()); !reflect.DeepEqual(verified, manifest) {
		t.Fatal("published manifest does not verify")
	}
}

func TestConcurrentDifferentGenerationsLeaveOneOwner(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore(0)
	payloads := testPayloads(3)
	const step = 61
	uploadAll(t, store, step, 1, payloads, noRetry())
	uploadAll(t, store, step, 2, payloads, noRetry())

	start := make(chan struct{})
	outcomes := make(chan commitOutcome, 2)
	for _, generation := range []uint64{1, 2} {
		generation := generation
		go func() {
			<-start
			result, err := (&Coordinator{
				Store: store, Step: step, Generation: generation, Ranks: len(payloads), Retry: noRetry(),
			}).Commit(ctx)
			outcomes <- commitOutcome{result: result, err: err}
		}()
	}
	close(start)

	created := 0
	committed := 0
	var winner Manifest
	for i := 0; i < 2; i++ {
		outcome := <-outcomes
		switch {
		case outcome.err == nil:
			if !outcome.result.Created {
				t.Fatalf("successful non-creating commit: %#v", outcome.result)
			}
			created++
			winner = outcome.result.Manifest
		case errors.Is(outcome.err, ErrStepCommitted):
			committed++
			winner = outcome.result.Manifest
		default:
			t.Fatalf("unexpected commit error: %v", outcome.err)
		}
	}
	if created != 1 || committed != 1 {
		t.Fatalf("created=%d committed=%d, want 1 and 1", created, committed)
	}
	verified := mustVerifyStep(t, store, step, noRetry())
	if !reflect.DeepEqual(verified, winner) {
		t.Fatal("winner manifest does not match published manifest")
	}
}
