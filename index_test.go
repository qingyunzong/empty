package segidx

import (
	"reflect"
	"sync"
	"testing"
)

func search(ix *Index, q Query) []string {
	return ix.Snapshot().Search(q)
}

func equalIDs(a, b []string) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	return reflect.DeepEqual(a, b)
}

func TestTermQuery(t *testing.T) {
	ix := New()
	ix.Add(
		Document{ID: "a", Text: "the quick brown fox"},
		Document{ID: "b", Text: "the lazy dog"},
	)
	if got, want := search(ix, Term("quick")), []string{"a"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if got, want := search(ix, Term("THE")), []string{"a", "b"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("case-insensitive: got %v want %v", got, want)
	}
	if got := search(ix, Term("missing")); len(got) != 0 {
		t.Fatalf("got %v want empty", got)
	}
}

func TestPhraseRequiresConsecutivePositions(t *testing.T) {
	ix := New()
	ix.Add(
		Document{ID: "consecutive", Text: "the quick brown fox jumps"},
		Document{ID: "gapped", Text: "quick red red fox"},
		Document{ID: "repeated", Text: "x y x"},
		Document{ID: "adjacent-repeat", Text: "x x"},
	)
	cases := []struct {
		q    Query
		want []string
	}{
		{Phrase("quick", "brown"), []string{"consecutive"}},
		{Phrase("quick", "brown", "fox"), []string{"consecutive"}},
		{Phrase("Quick", "Brown"), []string{"consecutive"}}, // normalized
		{Phrase("quick", "fox"), nil},                       // gap in both docs
		{Phrase("brown", "quick"), nil},                     // wrong order
		{Phrase("x", "x"), []string{"adjacent-repeat"}},     // repeated term needs p and p+1
		{Phrase("x", "y", "x"), []string{"repeated"}},
		{Phrase("y", "y"), nil},
		{Phrase(), nil}, // empty phrase matches nothing
	}
	for _, c := range cases {
		if got := search(ix, c.q); !equalIDs(got, c.want) {
			t.Errorf("%v: got %v want %v", c.q, got, c.want)
		}
	}
}

func TestPhraseAcrossPunctuation(t *testing.T) {
	ix := New()
	ix.Add(Document{ID: "a", Text: "hello, world!"})
	if got, want := search(ix, Phrase("hello", "world")), []string{"a"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestUpdateSameIDAtomicReplace(t *testing.T) {
	ix := New()
	ix.Add(Document{ID: "doc", Text: "hello world"})
	ix.Add(Document{ID: "doc", Text: "goodbye world"})
	if got := search(ix, Term("hello")); len(got) != 0 {
		t.Fatalf("stale version visible: %v", got)
	}
	if got, want := search(ix, Term("goodbye")), []string{"doc"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if got, want := search(ix, Term("world")), []string{"doc"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	// Phrase from the old version must not match either.
	if got := search(ix, Phrase("hello", "world")); len(got) != 0 {
		t.Fatalf("stale phrase visible: %v", got)
	}
}

func TestDeleteAndReAdd(t *testing.T) {
	ix := New()
	ix.Add(Document{ID: "a", Text: "alpha"})
	ix.Add(Document{ID: "b", Text: "alpha beta"})
	ix.Delete("a")
	if got, want := search(ix, Term("alpha")), []string{"b"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	ix.Add(Document{ID: "a", Text: "alpha again"})
	if got, want := search(ix, Term("alpha")), []string{"a", "b"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("re-add: got %v want %v", got, want)
	}
}

func TestSnapshotSeesOldDocuments(t *testing.T) {
	ix := New()
	ix.Add(Document{ID: "a", Text: "old text"}, Document{ID: "b", Text: "shared"})
	snap := ix.Snapshot()
	ix.Add(Document{ID: "a", Text: "new text"})
	ix.Delete("b")
	ix.Compact()

	// The old snapshot still sees the old versions.
	if got, want := snap.Search(Term("old")), []string{"a"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("old snapshot: got %v want %v", got, want)
	}
	if got, want := snap.Search(Term("shared")), []string{"b"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("old snapshot deleted doc: got %v want %v", got, want)
	}
	// A fresh snapshot sees the new state.
	if got := search(ix, Term("old")); len(got) != 0 {
		t.Fatalf("new snapshot: got %v want empty", got)
	}
	if got, want := search(ix, Term("new")), []string{"a"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("new snapshot: got %v want %v", got, want)
	}
}

func TestCompactDoesNotResurrectDeletes(t *testing.T) {
	ix := New()
	ix.Add(Document{ID: "a", Text: "alpha"})
	ix.Add(Document{ID: "b", Text: "beta"})
	ix.Add(Document{ID: "c", Text: "gamma"})
	ix.Delete("a", "c")
	ix.Compact()
	if ix.NumSegments() != 1 {
		t.Fatalf("segments after compact = %d, want 1", ix.NumSegments())
	}
	if got, want := search(ix, Or(Term("alpha"), Term("beta"), Term("gamma"))), []string{"b"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	// More writes after compaction must not bring deleted docs back.
	ix.Add(Document{ID: "d", Text: "delta"})
	ix.Compact()
	if got, want := search(ix, Not(Term("nomatch"))), []string{"b", "d"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPartialMergeRetainsTombstones(t *testing.T) {
	ix := New()
	ix.Add(Document{ID: "a", Text: "alpha"}) // segment 1 (v1)
	ix.Add(Document{ID: "b", Text: "beta"})  // segment 2 (v2)
	ix.Delete("a")                           // tombstone (v3)
	ix.Add(Document{ID: "c", Text: "gamma"}) // segment 3 (v4)
	if ix.NumSegments() != 3 {
		t.Fatalf("segments = %d, want 3", ix.NumSegments())
	}
	// Merge only the oldest segment; the tombstone for "a" must survive
	// because unmerged segments may still contain shadowed copies.
	ix.MergeOldest(1)
	if got := search(ix, Term("alpha")); len(got) != 0 {
		t.Fatalf("delete resurrected after partial merge: %v", got)
	}
	ix.MergeOldest(2)
	if got := search(ix, Term("alpha")); len(got) != 0 {
		t.Fatalf("delete resurrected after second merge: %v", got)
	}
	ix.Compact()
	if got, want := search(ix, Not(Term("nomatch"))), []string{"b", "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestMergeDropsShadowedVersions(t *testing.T) {
	ix := New()
	ix.Add(Document{ID: "a", Text: "version one"})
	ix.Add(Document{ID: "a", Text: "version two"})
	ix.Compact()
	st := ix.Snapshot().st
	if len(st.segments) != 1 || len(st.segments[0].docs) != 1 {
		t.Fatalf("shadowed version survived compaction: %+v", st.segments)
	}
	if got := search(ix, Term("one")); len(got) != 0 {
		t.Fatalf("old version term visible: %v", got)
	}
}

func TestConcurrentReadWrite(t *testing.T) {
	ix := New()
	ix.Add(Document{ID: "seed", Text: "alpha beta"})
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					ix.Snapshot().Search(Or(Term("alpha"), Phrase("alpha", "beta"), Not(Term("zz"))))
				}
			}
		}()
	}
	for i := 0; i < 500; i++ {
		ix.Add(Document{ID: "doc", Text: "alpha beta"})
		ix.Delete("doc")
		if i%50 == 0 {
			ix.Compact()
		}
	}
	close(stop)
	wg.Wait()
}
