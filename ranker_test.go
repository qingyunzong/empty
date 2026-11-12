package dataeng

import (
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
)

func mustApply(t *testing.T, r *Ranker, ops []Op, emit func([]Change) error) {
	t.Helper()
	if err := r.Apply(ops, emit); err != nil {
		t.Fatalf("Apply(%v): %v", ops, err)
	}
}

func capture(dst *[]Change) func([]Change) error {
	return func(ch []Change) error {
		*dst = append([]Change(nil), ch...)
		return nil
	}
}

func TestTieEvictionByIDOrder(t *testing.T) {
	r := New(2)

	var changes []Change
	mustApply(t, r, []Op{
		Upsert("c", "g", 10),
		Upsert("a", "g", 10),
		Upsert("b", "g", 10),
	}, capture(&changes))
	want := []Change{
		{Group: "g", Kind: ChangeAdded, ID: "a", NewRank: 1, NewScore: 10},
		{Group: "g", Kind: ChangeAdded, ID: "b", NewRank: 2, NewScore: 10},
	}
	if !reflect.DeepEqual(changes, want) {
		t.Fatalf("changes:\n got %+v\nwant %+v", changes, want)
	}
	if got := r.Top("g"); !reflect.DeepEqual(got, []Entry{{1, "a", 10}, {2, "b", 10}}) {
		t.Fatalf("board: %+v", got)
	}

	// Another tied ID sorts after the board cutoff: no diff, no emit.
	emitted := false
	mustApply(t, r, []Op{Upsert("d", "g", 10)}, func([]Change) error {
		emitted = true
		return nil
	})
	if emitted {
		t.Fatal("emit called for a batch with no board change")
	}

	// Deleting the top entry evicts nobody but pulls "c" onto the board.
	changes = nil
	mustApply(t, r, []Op{Delete("a")}, capture(&changes))
	want = []Change{
		{Group: "g", Kind: ChangeRemoved, ID: "a", OldRank: 1, OldScore: 10},
		{Group: "g", Kind: ChangeUpdated, ID: "b", OldRank: 2, NewRank: 1, OldScore: 10, NewScore: 10},
		{Group: "g", Kind: ChangeAdded, ID: "c", NewRank: 2, NewScore: 10},
	}
	if !reflect.DeepEqual(changes, want) {
		t.Fatalf("changes:\n got %+v\nwant %+v", changes, want)
	}
}

func TestMigrationBetweenGroups(t *testing.T) {
	r := New(2)
	mustApply(t, r, []Op{
		Upsert("x", "g1", 5),
		Upsert("y", "g1", 4),
		Upsert("p", "g2", 1),
	}, nil)

	var changes []Change
	mustApply(t, r, []Op{Upsert("x", "g2", 9)}, capture(&changes))
	want := []Change{
		{Group: "g1", Kind: ChangeRemoved, ID: "x", OldRank: 1, OldScore: 5},
		{Group: "g1", Kind: ChangeUpdated, ID: "y", OldRank: 2, NewRank: 1, OldScore: 4, NewScore: 4},
		{Group: "g2", Kind: ChangeAdded, ID: "x", NewRank: 1, NewScore: 9},
		{Group: "g2", Kind: ChangeUpdated, ID: "p", OldRank: 1, NewRank: 2, OldScore: 1, NewScore: 1},
	}
	if !reflect.DeepEqual(changes, want) {
		t.Fatalf("changes:\n got %+v\nwant %+v", changes, want)
	}
	if g, s, ok := r.Get("x"); !ok || g != "g2" || s != 9 {
		t.Fatalf("Get(x) = %q, %d, %v", g, s, ok)
	}
}

func TestDeleteReinsertWithinBatch(t *testing.T) {
	r := New(2)
	mustApply(t, r, []Op{Upsert("a", "g", 1), Upsert("b", "g", 2)}, nil)

	// Delete then re-insert the same ID with a new score in one batch.
	var changes []Change
	mustApply(t, r, []Op{Delete("a"), Upsert("a", "g", 5)}, capture(&changes))
	want := []Change{
		{Group: "g", Kind: ChangeUpdated, ID: "a", OldRank: 2, NewRank: 1, OldScore: 1, NewScore: 5},
		{Group: "g", Kind: ChangeUpdated, ID: "b", OldRank: 1, NewRank: 2, OldScore: 2, NewScore: 2},
	}
	if !reflect.DeepEqual(changes, want) {
		t.Fatalf("changes:\n got %+v\nwant %+v", changes, want)
	}

	// Delete then re-insert into a different group in one batch.
	mustApply(t, r, []Op{Upsert("c", "g1", 1)}, nil)
	changes = nil
	mustApply(t, r, []Op{Delete("c"), Upsert("c", "g2", 7)}, capture(&changes))
	want = []Change{
		{Group: "g1", Kind: ChangeRemoved, ID: "c", OldRank: 1, OldScore: 1},
		{Group: "g2", Kind: ChangeAdded, ID: "c", NewRank: 1, NewScore: 7},
	}
	if !reflect.DeepEqual(changes, want) {
		t.Fatalf("changes:\n got %+v\nwant %+v", changes, want)
	}
	if got := r.Top("g1"); got != nil {
		t.Fatalf("g1 board should be gone, got %+v", got)
	}
}

func TestDeleteMissingRollsBackBatch(t *testing.T) {
	r := New(2)
	mustApply(t, r, []Op{Upsert("a", "g", 1)}, nil)

	emitted := false
	err := r.Apply([]Op{Upsert("b", "g", 2), Delete("ghost")}, func([]Change) error {
		emitted = true
		return nil
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if emitted {
		t.Fatal("emit called for a rolled-back batch")
	}
	if _, _, ok := r.Get("b"); ok {
		t.Fatal("upsert before the failing delete leaked into the state")
	}
	if got := r.Top("g"); !reflect.DeepEqual(got, []Entry{{1, "a", 1}}) {
		t.Fatalf("board changed after rollback: %+v", got)
	}
	if r.Len() != 1 {
		t.Fatalf("Len = %d, want 1", r.Len())
	}
}

func TestInvalidOps(t *testing.T) {
	r := New(1)
	for _, op := range []Op{
		Upsert("", "g", 1),
		Upsert("a", "", 1),
		Delete(""),
		{Kind: OpKind(42), ID: "a"},
	} {
		if err := r.Apply([]Op{op}, nil); !errors.Is(err, ErrInvalidOp) {
			t.Fatalf("Apply(%v): err = %v, want ErrInvalidOp", op, err)
		}
	}
	if r.Len() != 0 {
		t.Fatalf("Len = %d, want 0", r.Len())
	}
}

func TestEmitFailureRollsBackAndRetry(t *testing.T) {
	r := New(2)
	mustApply(t, r, []Op{Upsert("a", "g", 1)}, nil)

	batch := []Op{Upsert("b", "g", 2), Upsert("c", "g", 3)}
	boom := errors.New("boom")
	err := r.Apply(batch, func([]Change) error { return boom })
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
	if got := r.Top("g"); !reflect.DeepEqual(got, []Entry{{1, "a", 1}}) {
		t.Fatalf("board changed after emit failure: %+v", got)
	}
	for _, id := range []string{"b", "c"} {
		if _, _, ok := r.Get(id); ok {
			t.Fatalf("record %q committed despite emit failure", id)
		}
	}

	// The same batch can be retried and must then commit.
	var first []Change
	if err := r.Apply(batch, capture(&first)); err != nil {
		t.Fatalf("retry: %v", err)
	}
	want := []Change{
		{Group: "g", Kind: ChangeRemoved, ID: "a", OldRank: 1, OldScore: 1},
		{Group: "g", Kind: ChangeAdded, ID: "c", NewRank: 1, NewScore: 3},
		{Group: "g", Kind: ChangeAdded, ID: "b", NewRank: 2, NewScore: 2},
	}
	if !reflect.DeepEqual(first, want) {
		t.Fatalf("changes:\n got %+v\nwant %+v", first, want)
	}
	if got := r.Top("g"); !reflect.DeepEqual(got, []Entry{{1, "c", 3}, {2, "b", 2}}) {
		t.Fatalf("board after retry: %+v", got)
	}
}

func TestChangeOrderingAcrossGroups(t *testing.T) {
	r := New(1)
	var changes []Change
	// Byte order: "Z" (0x5A) < "a" (0x61) < "é" (0xC3...).
	mustApply(t, r, []Op{
		Upsert("u1", "é", 1),
		Upsert("u2", "a", 2),
		Upsert("u3", "Z", 3),
	}, capture(&changes))
	want := []Change{
		{Group: "Z", Kind: ChangeAdded, ID: "u3", NewRank: 1, NewScore: 3},
		{Group: "a", Kind: ChangeAdded, ID: "u2", NewRank: 1, NewScore: 2},
		{Group: "é", Kind: ChangeAdded, ID: "u1", NewRank: 1, NewScore: 1},
	}
	if !reflect.DeepEqual(changes, want) {
		t.Fatalf("changes:\n got %+v\nwant %+v", changes, want)
	}
}

func TestRankAndScoreUpdates(t *testing.T) {
	r := New(3)
	mustApply(t, r, []Op{
		Upsert("a", "g", 1),
		Upsert("b", "g", 2),
		Upsert("c", "g", 3),
	}, nil)

	var changes []Change
	mustApply(t, r, []Op{Upsert("b", "g", 5)}, capture(&changes))
	want := []Change{
		{Group: "g", Kind: ChangeUpdated, ID: "b", OldRank: 2, NewRank: 1, OldScore: 2, NewScore: 5},
		{Group: "g", Kind: ChangeUpdated, ID: "c", OldRank: 1, NewRank: 2, OldScore: 3, NewScore: 3},
	}
	if !reflect.DeepEqual(changes, want) {
		t.Fatalf("changes:\n got %+v\nwant %+v", changes, want)
	}
}

func TestEmptyBatch(t *testing.T) {
	r := New(1)
	emitted := false
	mustApply(t, r, nil, func([]Change) error {
		emitted = true
		return nil
	})
	if emitted {
		t.Fatal("emit called for an empty batch")
	}
}

func TestNewPanicsOnNonPositiveK(t *testing.T) {
	for _, k := range []int{0, -1} {
		func() {
			defer func() {
				if recover() == nil {
					t.Fatalf("New(%d) did not panic", k)
				}
			}()
			New(k)
		}()
	}
}

func TestSnapshotIsolation(t *testing.T) {
	r := New(2)
	mustApply(t, r, []Op{Upsert("a", "g", 1), Upsert("b", "g", 2)}, nil)

	before := r.Top("g")
	mustApply(t, r, []Op{Upsert("c", "g", 3), Delete("a")}, nil)

	want := []Entry{{1, "b", 2}, {2, "a", 1}}
	if !reflect.DeepEqual(before, want) {
		t.Fatalf("old snapshot mutated by a later batch:\n got %+v\nwant %+v", before, want)
	}
	if got := r.Top("g"); !reflect.DeepEqual(got, []Entry{{1, "c", 3}, {2, "b", 2}}) {
		t.Fatalf("current board: %+v", got)
	}
}

func TestConcurrentReaders(t *testing.T) {
	r := New(4)
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				board := r.Top(fmt.Sprintf("g%d", i%2))
				for j, e := range board {
					if e.Rank != j+1 {
						t.Errorf("bad rank in snapshot: %+v", board)
						return
					}
				}
				_, _, _ = r.Get("id-3")
				_ = r.Len()
			}
		}(i)
	}
	for b := 0; b < 300; b++ {
		_ = r.Apply([]Op{
			Upsert(fmt.Sprintf("id-%d", b%20), fmt.Sprintf("g%d", b%2), int64(b)),
		}, nil)
	}
	close(stop)
	wg.Wait()
}
