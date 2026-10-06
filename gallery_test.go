package gallery

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"sync"
	"testing"
)

// collect drains all pages starting from cursor using the given page size.
func collect(t *testing.T, s *Store, cursor Cursor, limit int) []Edge {
	t.Helper()
	var all []Edge
	for {
		page, next, err := s.Page(cursor, limit)
		if err != nil {
			t.Fatalf("Page: %v", err)
		}
		all = append(all, page...)
		if len(page) < limit {
			return all
		}
		if next == cursor {
			t.Fatalf("cursor did not advance: %+v", next)
		}
		cursor = next
	}
}

func idsOf(edges []Edge) []uint64 {
	ids := make([]uint64, len(edges))
	for i, e := range edges {
		ids[i] = e.ID
	}
	return ids
}

func TestStableSortedPagination(t *testing.T) {
	s := NewStore(4)
	want := make([]Edge, 0, 10)
	for i := 0; i < 10; i++ {
		want = append(want, s.AddEdge(fmt.Sprintf("n%d", i), fmt.Sprintf("n%d", i+1)))
	}

	for _, limit := range []int{1, 3, 4, 10, 100} {
		got := collect(t, s, s.Begin(), limit)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("limit=%d: got %v, want %v", limit, idsOf(got), idsOf(want))
		}
	}
}

func TestCursorSnapshotIsolation(t *testing.T) {
	s := NewStore(64)
	base := make([]Edge, 0, 8)
	for i := 0; i < 8; i++ {
		base = append(base, s.AddEdge("a", fmt.Sprintf("b%d", i)))
	}

	cursor := s.Begin()
	snap, err := s.List(cursor)
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	// Mutate after pinning the cursor: delete some old edges, insert new ones.
	s.RemoveEdge(base[1].ID)
	s.RemoveEdge(base[5].ID)
	for i := 0; i < 5; i++ {
		s.AddEdge("x", fmt.Sprintf("y%d", i))
	}

	// The old cursor must still read exactly the snapshot at its version.
	got := collect(t, s, cursor, 3)
	if !reflect.DeepEqual(got, snap) {
		t.Fatalf("old cursor read set changed: got %v, want %v", idsOf(got), idsOf(snap))
	}

	// A fresh cursor sees the mutated state.
	fresh := collect(t, s, s.Begin(), 4)
	if len(fresh) != len(base)-2+5 {
		t.Fatalf("fresh cursor: got %d edges, want %d", len(fresh), len(base)-2+5)
	}
	for _, e := range fresh {
		if e.ID == base[1].ID || e.ID == base[5].ID {
			t.Fatalf("fresh cursor returned deleted edge %d", e.ID)
		}
	}
}

func TestExpiredCursor(t *testing.T) {
	s := NewStore(2)
	s.AddEdge("a", "b")
	stale := s.Begin()

	// Each mutation commits a version; exceed the retention window.
	for i := 0; i < 5; i++ {
		s.AddEdge("a", fmt.Sprintf("c%d", i))
	}

	if _, _, err := s.Page(stale, 10); !errors.Is(err, ErrCursorExpired) {
		t.Fatalf("Page with stale cursor: got %v, want ErrCursorExpired", err)
	}
	if _, err := s.List(stale); !errors.Is(err, ErrCursorExpired) {
		t.Fatalf("List with stale cursor: got %v, want ErrCursorExpired", err)
	}

	// A cursor within the retention window still works.
	recent := Cursor{Version: s.Version() - 1}
	if _, _, err := s.Page(recent, 10); err != nil {
		t.Fatalf("Page with recent cursor: %v", err)
	}
}

func TestBidirectionalIndex(t *testing.T) {
	s := NewStore(8)
	e1 := s.AddEdge("a", "b")
	e2 := s.AddEdge("a", "c")
	e3 := s.AddEdge("b", "c")
	e4 := s.AddEdge("c", "a")

	assertIDs := func(node string, dir Direction, want ...uint64) {
		t.Helper()
		got := s.Neighbors(node, dir)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Neighbors(%q, %v): got %v, want %v", node, dir, got, want)
		}
	}

	assertIDs("a", Out, e1.ID, e2.ID)
	assertIDs("a", In, e4.ID)
	assertIDs("b", Out, e3.ID)
	assertIDs("b", In, e1.ID)
	assertIDs("c", Out, e4.ID)
	assertIDs("c", In, e2.ID, e3.ID)
	assertIDs("nobody", Out)

	// Removal must update both sides of the index atomically.
	s.RemoveEdge(e2.ID)
	assertIDs("a", Out, e1.ID)
	assertIDs("c", In, e3.ID)

	// Removing a non-existent edge changes nothing.
	if s.RemoveEdge(9999) {
		t.Fatal("RemoveEdge(9999) reported success")
	}
	assertIDs("a", Out, e1.ID)
	assertIDs("c", In, e3.ID)
}

// TestIndexConsistentWithEdges verifies the bidirectional index always
// mirrors the live edge set after every atomic mutation.
func TestIndexConsistentWithEdges(t *testing.T) {
	s := NewStore(16)
	rng := rand.New(rand.NewSource(7))
	nodes := []string{"a", "b", "c", "d"}
	var live []Edge

	for step := 0; step < 500; step++ {
		if len(live) == 0 || rng.Intn(3) > 0 {
			live = append(live, s.AddEdge(nodes[rng.Intn(len(nodes))], nodes[rng.Intn(len(nodes))]))
		} else {
			i := rng.Intn(len(live))
			if !s.RemoveEdge(live[i].ID) {
				t.Fatalf("step %d: RemoveEdge(%d) failed", step, live[i].ID)
			}
			live = append(live[:i], live[i+1:]...)
		}

		// Rebuild the expected index from the live edge set and compare.
		outWant := map[string][]uint64{}
		inWant := map[string][]uint64{}
		for _, e := range live {
			outWant[e.Source] = append(outWant[e.Source], e.ID)
			inWant[e.Target] = append(inWant[e.Target], e.ID)
		}
		for _, n := range nodes {
			if got := s.Neighbors(n, Out); !reflect.DeepEqual(got, outWant[n]) {
				t.Fatalf("step %d: out-index[%q] = %v, want %v", step, n, got, outWant[n])
			}
			if got := s.Neighbors(n, In); !reflect.DeepEqual(got, inWant[n]) {
				t.Fatalf("step %d: in-index[%q] = %v, want %v", step, n, got, inWant[n])
			}
		}
	}
}

// TestRandomPaginationVsSnapshot performs random mutations, then paginates
// with random page sizes and compares the concatenated pages against the
// full snapshot list pinned at the cursor's version.
func TestRandomPaginationVsSnapshot(t *testing.T) {
	s := NewStore(4096)
	rng := rand.New(rand.NewSource(42))
	nodes := []string{"a", "b", "c", "d", "e"}
	var live []Edge

	for round := 0; round < 50; round++ {
		// Random batch of mutations.
		for i, n := 0, rng.Intn(8); i < n; i++ {
			if len(live) == 0 || rng.Intn(2) == 0 {
				live = append(live, s.AddEdge(nodes[rng.Intn(len(nodes))], nodes[rng.Intn(len(nodes))]))
			} else {
				j := rng.Intn(len(live))
				s.RemoveEdge(live[j].ID)
				live = append(live[:j], live[j+1:]...)
			}
		}

		cursor := s.Begin()
		want, err := s.List(cursor)
		if err != nil {
			t.Fatalf("round %d: List: %v", round, err)
		}

		// Paginate with random page sizes; mutate the store mid-iteration to
		// prove the pinned snapshot is unaffected.
		var got []Edge
		for {
			limit := 1 + rng.Intn(5)
			page, next, err := s.Page(cursor, limit)
			if err != nil {
				t.Fatalf("round %d: Page: %v", round, err)
			}
			got = append(got, page...)
			if rng.Intn(3) == 0 {
				s.AddEdge("z", "z")
			}
			if len(page) < limit {
				break
			}
			cursor = next
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("round %d: paginated %v, snapshot %v", round, idsOf(got), idsOf(want))
		}
	}
}

// TestConcurrentAccess exercises readers and writers racing with each other;
// run with -race to validate locking.
func TestConcurrentAccess(t *testing.T) {
	s := NewStore(1024)
	var wg sync.WaitGroup

	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 100; i++ {
				e := s.AddEdge(fmt.Sprintf("w%d", w), fmt.Sprintf("n%d", i))
				if i%3 == 0 {
					s.RemoveEdge(e.ID)
				}
			}
		}(w)
	}
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				cursor := s.Begin()
				page, _, err := s.Page(cursor, 10)
				if err != nil && !errors.Is(err, ErrCursorExpired) {
					t.Errorf("Page: %v", err)
					return
				}
				for j := 1; j < len(page); j++ {
					if page[j-1].ID >= page[j].ID {
						t.Errorf("page not sorted by ID: %v", idsOf(page))
						return
					}
				}
				s.Neighbors("w0", Out)
			}
		}()
	}
	wg.Wait()
}
