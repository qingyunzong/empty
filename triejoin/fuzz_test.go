package triejoin

import (
	"context"
	"errors"
	"math/rand"
	"reflect"
	"testing"
)

type failOpenCursor struct {
	TrieIterator
	id string
}

func (f *failOpenCursor) Open() error {
	if f.id == "bad" {
		return errors.New("open boom")
	}
	return f.TrieIterator.Open()
}

// TestRandomAgainstOracle runs many small random schemas (1..4 relations,
// 1..4 global variables, cyclic and acyclic shapes) and compares the leapfrog
// engine against the independent Cartesian-product + equality reference.
func TestRandomAgainstOracle(t *testing.T) {
	seed := int64(20261112)
	rng := rand.New(rand.NewSource(seed))
	for trial := 0; trial < 2000; trial++ {
		nVars := 1 + rng.Intn(4)
		vars := make([]string, nVars)
		for i := range vars {
			vars[i] = string(rune('a' + i))
		}
		nRels := 1 + rng.Intn(4)
		rels := make([]Relation, nRels)
		for r := 0; r < nRels; r++ {
			shuffled := append([]string(nil), vars...)
			rng.Shuffle(len(shuffled), func(i, j int) {
				shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
			})
			k := 1 + rng.Intn(nVars)
			if r == 0 {
				// The first relation covers every global variable so the
				// schema has a finite, non-trivially-empty result.
				k = nVars
			}
			cols := shuffled[:k]
			nRows := rng.Intn(6)
			tuples := make([][]int64, nRows)
			for i := range tuples {
				row := make([]int64, k)
				for j := range row {
					// Small domain so overlaps and collisions are frequent;
					// occasionally include negative values.
					row[j] = int64(rng.Intn(7) - 2)
				}
				tuples[i] = row
			}
			rels[r] = Relation{ID: string(rune('R' + r)), Columns: cols, Tuples: tuples}
		}

		want := referenceJoin(vars, rels)
		it, err := Join(context.Background(), vars, rels)
		if err != nil {
			t.Fatalf("trial %d vars=%v rels=%v: unexpected error %v", trial, vars, rels, err)
		}
		got, _, err := drain(it)
		if err != nil {
			t.Fatalf("trial %d drain: %v", trial, err)
		}
		if !sameRows(got, want) {
			t.Fatalf("trial %d mismatch\n vars=%v\n rels=%v\n got %v\nwant %v", trial, vars, rels, got, want)
		}
	}
}

func sameRows(a, b [][]int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !reflect.DeepEqual(a[i], b[i]) {
			return false
		}
	}
	return true
}

type errorFactory struct{ failOn string }

func (f errorFactory) NewIterator(snap RelationSnapshot) (TrieIterator, error) {
	if snap.ID == f.failOn {
		return nil, context.DeadlineExceeded
	}
	return MemFactory{}.NewIterator(snap)
}

func TestFactoryErrorAndCleanup(t *testing.T) {
	vars := []string{"a"}
	rels := []Relation{
		{ID: "good", Columns: []string{"a"}, Tuples: [][]int64{{1}}},
		{ID: "bad", Columns: []string{"a"}, Tuples: [][]int64{{1}}},
	}
	if _, err := Join(context.Background(), vars, rels, WithFactory(errorFactory{failOn: "bad"})); err == nil {
		t.Fatal("expected factory construction error")
	}

	// An adapter that fails on Open surfaces the wrapped relation ID.
	f := CursorFactoryFunc(func(snap RelationSnapshot) (TrieIterator, error) {
		base, _ := MemFactory{}.NewIterator(snap)
		return &failOpenCursor{TrieIterator: base, id: snap.ID}, nil
	})
	it, err := Join(context.Background(), vars, rels, WithFactory(f))
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	if _, _, err := it.Next(); err == nil {
		t.Fatal("expected open error to surface from Next")
	} else {
		var je *JoinError
		if !errors.As(err, &je) || je.RelationID != "bad" {
			t.Fatalf("expected wrapped JoinError for relation bad, got %v", err)
		}
	}
	if _, ok, err := it.Next(); err == nil || ok {
		t.Fatal("iterator must stay failed after an adapter error")
	}
}
