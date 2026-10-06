package graph

import (
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"testing"
)

func edgeIDs(edges []Edge) []uint64 {
	ids := make([]uint64, len(edges))
	for i, e := range edges {
		ids[i] = e.ID
	}
	return ids
}

// collectAll walks a cursor-based listing to exhaustion.
func collectAll(t *testing.T, list func(cursor string, limit int) (Page, error), limit int) []Edge {
	t.Helper()
	var all []Edge
	cursor := ""
	for {
		page, err := list(cursor, limit)
		if err != nil {
			t.Fatalf("list failed: %v", err)
		}
		all = append(all, page.Edges...)
		if page.NextCursor == "" {
			return all
		}
		cursor = page.NextCursor
	}
}

func TestStableOrderByEdgeID(t *testing.T) {
	s := NewStore(64)
	for i := 0; i < 50; i++ {
		s.AddEdge(fmt.Sprintf("v%d", i%7), fmt.Sprintf("v%d", (i+3)%7), "l")
	}
	all := collectAll(t, s.ListEdges, 7)
	if len(all) != 50 {
		t.Fatalf("got %d edges, want 50", len(all))
	}
	for i := 1; i < len(all); i++ {
		if all[i-1].ID >= all[i].ID {
			t.Fatalf("order not strictly ascending at %d: %d >= %d", i, all[i-1].ID, all[i].ID)
		}
	}
}

func TestCursorPinsSnapshotDeletesAndInsertsInvisible(t *testing.T) {
	s := NewStore(64)
	var ids []uint64
	for i := 0; i < 20; i++ {
		ids = append(ids, s.AddEdge("a", "b", "l").ID)
	}

	// First page pins the snapshot version.
	page1, err := s.ListEdges("", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(page1.Edges) != 5 || page1.NextCursor == "" {
		t.Fatalf("bad first page: %+v", page1)
	}
	pinnedVersion, _, err := decodeCursor(page1.NextCursor)
	if err != nil {
		t.Fatal(err)
	}

	// Mutate heavily: delete some already-seen and unseen edges, insert new ones.
	for _, id := range ids[:10] {
		if err := s.RemoveEdge(id); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 8; i++ {
		s.AddEdge("x", "y", "l")
	}

	// Continue with the old cursor: the read set must be exactly the
	// remainder of the original snapshot.
	var rest []Edge
	cursor := page1.NextCursor
	for cursor != "" {
		p, err := s.ListEdges(cursor, 4)
		if err != nil {
			t.Fatalf("old cursor must keep working: %v", err)
		}
		rest = append(rest, p.Edges...)
		cursor = p.NextCursor
	}
	got := append(page1.Edges, rest...)

	// Cross-check against the pinned snapshot's full list.
	want, err := s.SnapshotEdges(pinnedVersion)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(edgeIDs(got)) != fmt.Sprint(edgeIDs(want)) {
		t.Fatalf("old cursor read %v, want original snapshot %v", edgeIDs(got), edgeIDs(want))
	}
	if len(got) != 20 {
		t.Fatalf("old cursor read %d edges, want original 20", len(got))
	}
}

func TestExpiredCursorError(t *testing.T) {
	s := NewStore(3) // retain only 3 versions
	for i := 0; i < 3; i++ {
		s.AddEdge("a", "b", "l")
	}
	page, err := s.ListEdges("", 1)
	if err != nil {
		t.Fatal(err)
	}
	if page.NextCursor == "" {
		t.Fatal("expected a next cursor")
	}
	// Push the pinned version out of the retention window.
	for i := 0; i < 5; i++ {
		s.AddEdge("a", "b", "l")
	}
	_, err = s.ListEdges(page.NextCursor, 1)
	if !errors.Is(err, ErrCursorExpired) {
		t.Fatalf("got %v, want ErrCursorExpired", err)
	}
}

func TestInvalidCursorError(t *testing.T) {
	s := NewStore(4)
	for _, c := range []string{"junk", "v1", "v1:x", "1:2", "v-1:2"} {
		if _, err := s.ListEdges(c, 1); !errors.Is(err, ErrInvalidCursor) {
			t.Fatalf("cursor %q: got %v, want ErrInvalidCursor", c, err)
		}
	}
}

func TestBidirectionalIndexConsistent(t *testing.T) {
	s := NewStore(64)
	e1 := s.AddEdge("a", "b", "l")
	e2 := s.AddEdge("a", "c", "l")
	e3 := s.AddEdge("d", "b", "l")

	out := collectAll(t, func(c string, l int) (Page, error) { return s.ListOutEdges("a", c, l) }, 1)
	if got, want := edgeIDs(out), []uint64{e1.ID, e2.ID}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("out(a) = %v, want %v", got, want)
	}
	in := collectAll(t, func(c string, l int) (Page, error) { return s.ListInEdges("b", c, l) }, 1)
	if got, want := edgeIDs(in), []uint64{e1.ID, e3.ID}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("in(b) = %v, want %v", got, want)
	}

	// Removal must hit both indexes atomically.
	if err := s.RemoveEdge(e1.ID); err != nil {
		t.Fatal(err)
	}
	out = collectAll(t, func(c string, l int) (Page, error) { return s.ListOutEdges("a", c, l) }, 10)
	in = collectAll(t, func(c string, l int) (Page, error) { return s.ListInEdges("b", c, l) }, 10)
	if got := edgeIDs(out); fmt.Sprint(got) != fmt.Sprint([]uint64{e2.ID}) {
		t.Fatalf("after remove out(a) = %v", got)
	}
	if got := edgeIDs(in); fmt.Sprint(got) != fmt.Sprint([]uint64{e3.ID}) {
		t.Fatalf("after remove in(b) = %v", got)
	}
	if err := s.RemoveEdge(9999); !errors.Is(err, ErrEdgeNotFound) {
		t.Fatalf("got %v, want ErrEdgeNotFound", err)
	}
}

// TestConcurrentAtomicIndexUpdates hammers the store with writers while
// readers verify that every observed snapshot has consistent out/in indexes.
// Run with -race for full effect.
func TestConcurrentAtomicIndexUpdates(t *testing.T) {
	s := NewStore(128)
	var wg sync.WaitGroup
	stop := make(chan struct{})

	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			var live []uint64
			for i := 0; i < 300; i++ {
				select {
				case <-stop:
					return
				default:
				}
				if len(live) > 0 && i%3 == 0 {
					id := live[0]
					live = live[1:]
					_ = s.RemoveEdge(id)
				} else {
					e := s.AddEdge(fmt.Sprintf("w%d", w), "hub", "l")
					live = append(live, e.ID)
				}
			}
		}(w)
	}

	// Readers: every edge visible in out(w) must be visible in in(hub) of the
	// same version, and vice versa — indexes commit atomically.
	for r := 0; r < 3; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				v := s.Version()
				edges, err := s.SnapshotEdges(v)
				if err != nil {
					continue // version evicted mid-check; retry
				}
				outSet := map[uint64]bool{}
				for w := 0; w < 4; w++ {
					p, err := s.ListOutEdges(fmt.Sprintf("w%d", w), encodeCursor(v, 0), 100000)
					if err != nil {
						break
					}
					for _, e := range p.Edges {
						outSet[e.ID] = true
					}
				}
				p, err := s.ListInEdges("hub", encodeCursor(v, 0), 100000)
				if err != nil {
					continue
				}
				inSet := map[uint64]bool{}
				for _, e := range p.Edges {
					inSet[e.ID] = true
				}
				for _, e := range edges {
					if outSet[e.ID] != inSet[e.ID] {
						t.Errorf("version %d: edge %d out=%v in=%v", v, e.ID, outSet[e.ID], inSet[e.ID])
						return
					}
				}
			}
		}()
	}
	wg.Wait()
	close(stop)
}

// TestRandomPaginationMatchesSnapshot does randomized pagination (random
// page sizes, interleaved mutations) and cross-checks the concatenated
// pages against the pinned snapshot's full edge list.
func TestRandomPaginationMatchesSnapshot(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 30; trial++ {
		s := NewStore(4096)
		n := 1 + rng.Intn(120)
		for i := 0; i < n; i++ {
			s.AddEdge(fmt.Sprintf("v%d", rng.Intn(10)), fmt.Sprintf("v%d", rng.Intn(10)), "l")
		}

		// Pin a snapshot via the first page.
		pageSize := 1 + rng.Intn(9)
		first, err := s.ListEdges("", pageSize)
		if err != nil {
			t.Fatal(err)
		}
		pinnedVersion := s.Version()

		// Interleave random mutations that must not affect the pinned read.
		for i := 0; i < rng.Intn(30); i++ {
			if rng.Intn(2) == 0 {
				_ = s.RemoveEdge(uint64(1 + rng.Intn(n))) // may not exist; fine
			} else {
				s.AddEdge("noise", "noise", "l")
			}
		}

		// Walk the rest with random page sizes.
		got := append([]Edge(nil), first.Edges...)
		cursor := first.NextCursor
		for cursor != "" {
			p, err := s.ListEdges(cursor, 1+rng.Intn(9))
			if err != nil {
				t.Fatalf("trial %d: %v", trial, err)
			}
			got = append(got, p.Edges...)
			cursor = p.NextCursor
		}

		// Cross-check against the snapshot's full list at the pinned version.
		want, err := s.SnapshotEdges(pinnedVersion)
		if err != nil {
			t.Fatalf("trial %d: snapshot lookup: %v", trial, err)
		}
		if fmt.Sprint(edgeIDs(got)) != fmt.Sprint(edgeIDs(want)) {
			t.Fatalf("trial %d: paginated %v != snapshot %v", trial, edgeIDs(got), edgeIDs(want))
		}
	}
}

// TestRandomPaginationOutInMatchesSnapshot cross-checks per-vertex
// bidirectional listings against the full snapshot edge list.
func TestRandomPaginationOutInMatchesSnapshot(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	s := NewStore(4096)
	vertices := []string{"a", "b", "c", "d"}
	for i := 0; i < 200; i++ {
		s.AddEdge(vertices[rng.Intn(4)], vertices[rng.Intn(4)], "l")
	}
	version := s.Version()
	full, err := s.SnapshotEdges(version)
	if err != nil {
		t.Fatal(err)
	}
	pin := encodeCursor(version, 0)

	for _, v := range vertices {
		var wantOut, wantIn []uint64
		for _, e := range full {
			if e.From == v {
				wantOut = append(wantOut, e.ID)
			}
			if e.To == v {
				wantIn = append(wantIn, e.ID)
			}
		}
		gotOut := collectAll(t, func(c string, l int) (Page, error) {
			if c == "" {
				c = pin
			}
			return s.ListOutEdges(v, c, l)
		}, 1+rng.Intn(5))
		gotIn := collectAll(t, func(c string, l int) (Page, error) {
			if c == "" {
				c = pin
			}
			return s.ListInEdges(v, c, l)
		}, 1+rng.Intn(5))
		if fmt.Sprint(edgeIDs(gotOut)) != fmt.Sprint(wantOut) {
			t.Fatalf("out(%s) = %v, want %v", v, edgeIDs(gotOut), wantOut)
		}
		if fmt.Sprint(edgeIDs(gotIn)) != fmt.Sprint(wantIn) {
			t.Fatalf("in(%s) = %v, want %v", v, edgeIDs(gotIn), wantIn)
		}
	}
}
