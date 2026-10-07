package synclib_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"example.com/synclib"
	"example.com/synclib/fakestore"
)

// manualClock is a test clock advanced explicitly by the backoff hook.
type manualClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *manualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *manualClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func TestRetryReadsFirstAndSkipsWriteWhenAlreadySynced(t *testing.T) {
	store := fakestore.New()
	if _, err := store.Write(context.Background(), wantRecord()); err != nil {
		t.Fatal(err)
	}
	s := &synclib.Syncer{Store: store}
	receipt, err := s.SyncWithRetry(context.Background(), wantRecord(),
		synclib.RetryPolicy{MaxAttempts: 3})
	if err != nil {
		t.Fatalf("SyncWithRetry: %v", err)
	}
	if receipt.Version != 1 {
		t.Fatalf("want existing receipt version 1, got %+v", receipt)
	}
	if got := store.WriteCalls(); got != 1 {
		t.Fatalf("retry must not rewrite confirmed state, writes = %d", got)
	}
}

func TestRetryHealsPartialWrite(t *testing.T) {
	store := fakestore.New()
	store.Partials = []fakestore.PartialWrite{{
		OnCall:          1,
		DropFields:      []string{"body"},
		DropAttachments: []string{"b.txt"},
	}}
	s := &synclib.Syncer{Store: store}
	receipt, err := s.SyncWithRetry(context.Background(), wantRecord(),
		synclib.RetryPolicy{MaxAttempts: 3})
	if err != nil {
		t.Fatalf("SyncWithRetry: %v", err)
	}
	if receipt.Version != 2 {
		t.Fatalf("want second write to succeed, got %+v", receipt)
	}
	got, _, err := store.Read(context.Background(), "rec-1")
	if err != nil {
		t.Fatal(err)
	}
	if !s.Matches(wantRecord(), got) {
		t.Fatalf("final state does not match: %+v", got)
	}
}

func TestRetryExhaustionReturnsMismatchWithReceiptAndDiffs(t *testing.T) {
	store := fakestore.New()
	store.Partials = []fakestore.PartialWrite{{
		OnCall:     0, // every write is partial
		DropFields: []string{"body"},
	}}
	s := &synclib.Syncer{Store: store}
	_, err := s.SyncWithRetry(context.Background(), wantRecord(),
		synclib.RetryPolicy{MaxAttempts: 2})
	var me *synclib.MismatchError
	if !errors.As(err, &me) {
		t.Fatalf("want MismatchError, got %v", err)
	}
	if me.Receipt.Version != 2 {
		t.Fatalf("want receipt of last write, got %+v", me.Receipt)
	}
	if len(me.Diffs) != 1 || me.Diffs[0].Field != "body" {
		t.Fatalf("unexpected diffs: %v", me.Diffs)
	}
}

func TestRetrySurvivesDelayedReadBack(t *testing.T) {
	clock := &manualClock{now: time.Unix(1_700_000_000, 0)}
	store := fakestore.New()
	store.SetClock(clock.Now)
	store.ConsistencyWindow = time.Minute

	s := &synclib.Syncer{Store: store}
	policy := synclib.RetryPolicy{
		MaxAttempts: 3,
		Backoff:     2 * time.Minute,
		Sleep: func(ctx context.Context, d time.Duration) error {
			clock.Advance(d)
			return nil
		},
	}
	receipt, err := s.SyncWithRetry(context.Background(), wantRecord(), policy)
	if err != nil {
		t.Fatalf("SyncWithRetry: %v", err)
	}
	if receipt.Version != 1 {
		t.Fatalf("want first write confirmed after delay, got %+v", receipt)
	}
	if got := store.WriteCalls(); got != 1 {
		t.Fatalf("read-first must confirm delayed write, writes = %d", got)
	}
}
