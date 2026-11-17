package formal

import (
	"context"
	"errors"
	"testing"
)

func TestMemStoreReadPagination(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	for i := 0; i < 5; i++ {
		txn := store.Begin()
		if err := txn.Put(Key(rune('a'+i)), Value(string(rune('0'+i)))); err != nil {
			t.Fatal(err)
		}
		if _, err := txn.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}

	var seen []Seq
	after := Seq(0)
	for {
		batch, err := store.Read(ctx, after, 5, 2)
		if err != nil {
			t.Fatal(err)
		}
		if len(batch.Commits) > 2 {
			t.Fatalf("page has %d commits, limit 2", len(batch.Commits))
		}
		for _, cm := range batch.Commits {
			if cm.Seq <= after {
				t.Fatalf("page returned %d at or below after %d", cm.Seq, after)
			}
			seen = append(seen, cm.Seq)
			after = cm.Seq
		}
		if batch.Done {
			break
		}
	}
	if len(seen) != 5 {
		t.Fatalf("saw %d commits, want 5", len(seen))
	}
	for i, seq := range seen {
		if seq != Seq(i+1) {
			t.Fatalf("commit order = %v", seen)
		}
	}

	batch, err := store.Read(ctx, 5, 5, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Commits) != 0 || !batch.Done {
		t.Fatalf("empty range = %+v", batch)
	}

	if _, err := store.Read(ctx, 0, 6, 2); !errors.Is(err, ErrFutureWatermark) {
		t.Fatalf("future read = %v, want ErrFutureWatermark", err)
	}
}

func TestMemStoreSnapshotIsolation(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	txn := store.Begin()
	if err := txn.Put("a", "old"); err != nil {
		t.Fatal(err)
	}
	if _, err := txn.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	snap, err := store.OpenSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}

	txn = store.Begin()
	if err := txn.Put("a", "new"); err != nil {
		t.Fatal(err)
	}
	if err := txn.Put("b", "added"); err != nil {
		t.Fatal(err)
	}
	if _, err := txn.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	got := make(map[Key]Value)
	if err := snap.Scan(ctx, func(k Key, v Value) error {
		got[k] = v
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got["a"] != "old" {
		t.Fatalf("snapshot changed after commit: %v", got)
	}

	historical, err := store.OpenSnapshotAt(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	got = make(map[Key]Value)
	if err := historical.Scan(ctx, func(k Key, v Value) error {
		got[k] = v
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got["a"] != "old" {
		t.Fatalf("historical snapshot at 1 = %v", got)
	}
	if _, err := store.OpenSnapshotAt(ctx, 3); !errors.Is(err, ErrFutureWatermark) {
		t.Fatalf("future snapshot = %v, want ErrFutureWatermark", err)
	}
}

func TestMemStoreRollbackAndEmptyTransactions(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()

	txn := store.Begin()
	if err := txn.Put("ghost", "x"); err != nil {
		t.Fatal(err)
	}
	if err := txn.Rollback(); err != nil {
		t.Fatal(err)
	}

	empty := store.Begin()
	seq, err := empty.Commit(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if seq != 0 {
		t.Fatalf("empty transaction consumed seq %d", seq)
	}
	if store.CommitCount() != 0 {
		t.Fatalf("commit count = %d, want 0", store.CommitCount())
	}

	snap, err := store.OpenSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := snap.Scan(ctx, func(k Key, v Value) error {
		t.Fatalf("rolled-back key visible: %s=%s", k, v)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	finished := store.Begin()
	if err := finished.Put("a", "1"); err != nil {
		t.Fatal(err)
	}
	if _, err := finished.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := finished.Put("b", "2"); !errors.Is(err, ErrTxnDone) {
		t.Fatalf("Put after commit = %v, want ErrTxnDone", err)
	}
}

func TestMemTransactionChangeOrder(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	txn := store.Begin()
	if err := txn.Put("a", "1"); err != nil {
		t.Fatal(err)
	}
	if err := txn.Delete("a"); err != nil {
		t.Fatal(err)
	}
	if err := txn.Put("b", "1"); err != nil {
		t.Fatal(err)
	}
	if err := txn.Delete("b"); err != nil {
		t.Fatal(err)
	}
	if err := txn.Put("b", "2"); err != nil {
		t.Fatal(err)
	}
	if _, err := txn.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	values, err := store.Values(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 1 || values["b"] != "2" {
		t.Fatalf("values = %v", values)
	}
}
