package formal

import (
	"context"
	"errors"
	"testing"
)

var errStorage = errors.New("test: storage unavailable")

type failingStore struct {
	err   error
	calls int
}

func (s *failingStore) Put(context.Context, string, []byte, Condition) (Object, error) {
	s.calls++
	return Object{}, s.err
}

func (s *failingStore) Get(context.Context, string) (Object, error) {
	s.calls++
	return Object{}, s.err
}

func TestCommitAndUploadPropagatePermanentStorageErrors(t *testing.T) {
	ctx := context.Background()
	store := &failingStore{err: errStorage}

	if _, err := (&Uploader{Store: store, Step: 1, Generation: 1, Rank: 0}).Upload(ctx, []byte("payload")); !errors.Is(err, errStorage) {
		t.Fatalf("upload: got %v, want storage error", err)
	}
	if _, err := (&Coordinator{Store: store, Step: 1, Generation: 1, Ranks: 1}).Commit(ctx); !errors.Is(err, errStorage) {
		t.Fatalf("commit: got %v, want storage error", err)
	}
}

func TestGetWithRetryDoesNotRetryPermanentErrors(t *testing.T) {
	store := &failingStore{err: errStorage}
	_, err := getWithRetry(context.Background(), store, "k", RetryPolicy{Attempts: 10})
	if !errors.Is(err, errStorage) {
		t.Fatalf("got %v, want storage error", err)
	}
	if store.calls != 1 {
		t.Fatalf("made %d attempts, want 1", store.calls)
	}
}

func TestGetWithRetryExhaustsBudgetOnNotFound(t *testing.T) {
	store := NewMemStore(0)
	_, err := getWithRetry(context.Background(), store, "absent", RetryPolicy{Attempts: 3})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
}

func TestInvalidConfigurationAndRank(t *testing.T) {
	ctx := context.Background()
	if _, err := (&Coordinator{Store: NewMemStore(0), Ranks: 0}).Commit(ctx); err == nil {
		t.Fatal("zero rank commit succeeded")
	}
	if _, err := (&Coordinator{Store: nil, Ranks: 1}).Commit(ctx); err == nil {
		t.Fatal("nil store commit succeeded")
	}
	if _, err := (&Uploader{Store: NewMemStore(0), Rank: -1}).Upload(ctx, nil); err == nil {
		t.Fatal("negative rank upload succeeded")
	}
	if _, err := (&Uploader{Store: nil}).Upload(ctx, nil); err == nil {
		t.Fatal("nil store upload succeeded")
	}
}

func TestStepCommittedErrorUnwraps(t *testing.T) {
	err := &StepCommittedError{Step: 9, Manifest: Manifest{Generation: 4, RankCount: 2}}
	if !errors.Is(err, ErrStepCommitted) {
		t.Fatal("StepCommittedError does not unwrap to ErrStepCommitted")
	}
	if err.Error() == "" {
		t.Fatal("empty error message")
	}
}
