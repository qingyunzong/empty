package delivery

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
)

type fakeDB struct {
	mu     sync.Mutex
	rows   map[Tag]Record
	failOn map[Tag]bool
	calls  int
}

func newFakeDB() *fakeDB {
	return &fakeDB{
		rows:   make(map[Tag]Record),
		failOn: make(map[Tag]bool),
	}
}

func (db *fakeDB) commit(_ context.Context, rec Record) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.calls++
	if db.failOn[rec.Tag] {
		return fmt.Errorf("simulated write failure for %q", rec.Tag)
	}
	if _, ok := db.rows[rec.Tag]; ok {
		return fmt.Errorf("duplicate write for %q", rec.Tag)
	}
	db.rows[rec.Tag] = rec
	return nil
}

func (db *fakeDB) writes() int {
	db.mu.Lock()
	defer db.mu.Unlock()
	return db.calls
}

func newTestTracker(t *testing.T) (*Tracker, *MemoryStore) {
	t.Helper()
	ctx := context.Background()
	store := NewMemoryStore()
	tracker, err := NewTracker(ctx, store)
	if err != nil {
		t.Fatalf("NewTracker: %v", err)
	}
	if _, err := tracker.BeginGeneration(ctx); err != nil {
		t.Fatalf("BeginGeneration: %v", err)
	}
	return tracker, store
}

func TestIncomingAndDuplicateTransfer(t *testing.T) {
	ctx := context.Background()
	tracker, store := newTestTracker(t)
	db := newFakeDB()

	first, err := tracker.Incoming(ctx, "tag-a", 100)
	if err != nil || first.Duplicate || first.Record.LinkEpoch != 1 {
		t.Fatalf("first Incoming = %+v, %v", first, err)
	}
	dup, err := tracker.Incoming(ctx, "tag-a", 100)
	if err != nil || !dup.Duplicate {
		t.Fatalf("duplicate Incoming = %+v, %v", dup, err)
	}

	rec, err := tracker.Commit(ctx, "tag-a", db.commit)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if !rec.Committed || rec.Outcome != OutcomeAccepted || rec.Settled {
		t.Fatalf("post-commit record = %+v", rec)
	}
	again, err := tracker.Incoming(ctx, "tag-a", 100)
	if err != nil || !again.Duplicate {
		t.Fatalf("re-arrival = %+v, %v", again, err)
	}
	rec2, err := tracker.Commit(ctx, "tag-a", db.commit)
	if err != nil {
		t.Fatalf("idempotent Commit: %v", err)
	}
	if !rec2.Committed || rec2.Outcome != OutcomeAccepted {
		t.Fatalf("idempotent commit record = %+v", rec2)
	}
	if db.writes() != 1 {
		t.Fatalf("db writes = %d, want exactly 1", db.writes())
	}

	stored, err := store.Get(ctx, "tag-a")
	if err != nil || stored.Settled {
		t.Fatalf("stored record unexpectedly settled: %+v, %v", stored, err)
	}
}

func TestAcceptedOnlyAfterCommit(t *testing.T) {
	ctx := context.Background()
	tracker, _ := newTestTracker(t)
	db := newFakeDB()
	db.failOn["tag-b"] = true

	if _, err := tracker.Incoming(ctx, "tag-b", 1); err != nil {
		t.Fatalf("Incoming: %v", err)
	}
	if _, err := tracker.Commit(ctx, "tag-b", db.commit); err == nil {
		t.Fatal("Commit with failing callback must return an error")
	}
	recs, err := tracker.Reconcile(ctx)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if len(recs) != 1 || recs[0].Committed || recs[0].Outcome == OutcomeAccepted {
		t.Fatalf("failed commit must not produce accepted: %+v", recs)
	}

	db.failOn["tag-b"] = false
	committed, err := tracker.Commit(ctx, "tag-b", db.commit)
	if err != nil {
		t.Fatalf("retry Commit: %v", err)
	}
	if !committed.Committed || committed.Outcome != OutcomeAccepted {
		t.Fatalf("accepted only after durable commit: %+v", committed)
	}
}

func TestIncomingRequiresGeneration(t *testing.T) {
	ctx := context.Background()
	tracker, err := NewTracker(ctx, NewMemoryStore())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tracker.Incoming(ctx, "x", 1); !errors.Is(err, ErrNoActiveGeneration) {
		t.Fatalf("Incoming before attach = %v, want ErrNoActiveGeneration", err)
	}
}

func TestConcurrentIncomingSingleWrite(t *testing.T) {
	ctx := context.Background()
	tracker, _ := newTestTracker(t)
	db := newFakeDB()

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := tracker.Incoming(ctx, "hot", 1); err != nil {
				t.Errorf("Incoming: %v", err)
				return
			}
			if _, err := tracker.Commit(ctx, "hot", db.commit); err != nil {
				t.Errorf("Commit: %v", err)
			}
		}()
	}
	wg.Wait()
	if db.writes() != 1 {
		t.Fatalf("concurrent commits produced %d writes, want 1", db.writes())
	}
}
