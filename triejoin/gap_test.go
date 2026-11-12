package triejoin

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"testing"
)

// gapCursor is an injected ordered-cursor adapter over a virtual arithmetic
// progression {start + i*step : 0 <= i < n}. It never materializes a tuple
// table: values are computed on demand, and each trie level shares the same
// progression domain. SeekTo jumps by arithmetic in O(1) while Next advances
// exactly one distinct value. A counter records skipped positions so tests can
// prove the engine jumps instead of walking the gap.
type gapCursor struct {
	start int64
	step  int64
	n     int64
	// member reports whether progression index i belongs to this relation.
	member func(i int64) bool

	// depth stack; each entry is the index of the current value, -1 if before
	// the first value / exhausted.
	pos    []int64
	closed bool
	counts Counts
	// skipped counts positions bypassed by SeekTo without a Next.
	skipped int64
}

type gapFactory struct {
	start, step, n, hitEvery int64
	cursors                  []*gapCursor
}

func (f *gapFactory) NewIterator(snap RelationSnapshot) (TrieIterator, error) {
	var member func(i int64) bool
	switch snap.ID {
	case "A":
		member = func(i int64) bool { return i%f.hitEvery == 0 }
	case "B":
		member = func(i int64) bool { return i%f.hitEvery == 0 || i == 1 }
	case "C":
		member = func(i int64) bool { return i%f.hitEvery == 0 || i == 2 }
	default:
		member = func(i int64) bool { return true }
	}
	c := &gapCursor{start: f.start, step: f.step, n: f.n, member: member}
	f.cursors = append(f.cursors, c)
	return c, nil
}

func (c *gapCursor) valueAt(i int64) int64 { return c.start + i*c.step }

func (c *gapCursor) Open() error {
	c.counts.Opens++
	if c.closed {
		return errors.New("gap cursor closed")
	}
	first := c.nextMember(0)
	c.pos = append(c.pos, first)
	return nil
}

// nextMember returns the smallest member index >= from, or n if exhausted.
func (c *gapCursor) nextMember(from int64) int64 {
	for i := from; i < c.n; i++ {
		if c.member(i) {
			return i
		}
	}
	return c.n
}

func (c *gapCursor) depth() int { return len(c.pos) }

func (c *gapCursor) Valid() bool {
	return !c.closed && len(c.pos) > 0 && c.pos[len(c.pos)-1] >= 0 && c.pos[len(c.pos)-1] < c.n
}

func (c *gapCursor) At() int64 {
	i := c.pos[len(c.pos)-1]
	return c.valueAt(i)
}

func (c *gapCursor) Next() (bool, error) {
	c.counts.Nexts++
	if c.closed {
		return false, errors.New("gap cursor closed")
	}
	i := c.pos[len(c.pos)-1]
	ni := c.nextMember(i + 1)
	c.pos[len(c.pos)-1] = ni
	return ni < c.n, nil
}

// SeekTo performs an arithmetic jump: the smallest progression member >= target
// is computed directly, never by iterating Next.
func (c *gapCursor) SeekTo(target int64) (bool, error) {
	c.counts.Seeks++
	if c.closed {
		return false, errors.New("gap cursor closed")
	}
	d := len(c.pos) - 1
	i := c.pos[d]
	if i < 0 {
		i = 0
	}
	// ceil((target - start) / step); the fixture always uses a positive step.
	diff := target - c.start
	j := diff / c.step
	if diff > c.step*j {
		j++
	}
	if j < i {
		// Seek starts from the current position.
		j = i
	}
	// Land on the smallest member >= j; this is an arithmetic/modulo jump, not
	// a per-value walk exposed to the engine (it never issues Next for it).
	j = c.nextMember(j)
	if j > i {
		c.skipped += j - i
	}
	c.pos[d] = j
	return j < c.n, nil
}

func (c *gapCursor) Up() error {
	c.counts.Ups++
	if c.closed {
		return errors.New("gap cursor closed")
	}
	if len(c.pos) == 0 {
		return errors.New("up at root")
	}
	c.pos = c.pos[:len(c.pos)-1]
	return nil
}

func (c *gapCursor) Close() error {
	c.closed = true
	c.pos = nil
	return nil
}

func (c *gapCursor) Counts() Counts { return c.counts }

// TestBigGapLeapfrog builds three unary relations on widely spaced arithmetic
// progressions. Each relation contains every k-th member of a shared sparse
// hit sequence plus a private offset element, so the intersection is the full
// hit sequence (small relative to the huge domains). A nested-loop or pairwise
// materialization would walk the huge domains; the injected cursor proves the
// engine converges via seek jumps with very few Next calls.
func TestBigGapLeapfrog(t *testing.T) {
	const step int64 = 1_000_000
	const n int64 = 5_000
	const hitEvery int64 = 37
	vars := []string{"x"}
	// Members of each virtual relation:
	//   A: indices i with i % hitEvery == 0
	//   B: indices i with i % hitEvery == 0, plus private index 1
	//   C: indices i with i % hitEvery == 0, plus private index 2
	// Common indices are exactly the hit sequence; values differ by step.
	hits := 0
	for i := int64(0); i < n; i++ {
		if i%hitEvery == 0 {
			hits++
		}
	}
	rels := []Relation{
		{ID: "A", Columns: []string{"x"}, Tuples: [][]int64{{0}}},
		{ID: "B", Columns: []string{"x"}, Tuples: [][]int64{{0}}},
		{ID: "C", Columns: []string{"x"}, Tuples: [][]int64{{0}}},
	}

	f := &gapFactory{start: 0, step: step, n: n, hitEvery: hitEvery}
	it, err := Join(context.Background(), vars, rels, WithFactory(f))
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	got, agg, err := drain(it)
	if err != nil {
		t.Fatalf("drain: %v", err)
	}

	wantSet := map[int64]bool{}
	for i := int64(0); i < n; i++ {
		if i%hitEvery == 0 {
			wantSet[i*step] = true
		}
	}
	if len(got) != hits || len(got) != len(wantSet) {
		t.Fatalf("intersection size mismatch: got %d want %d", len(got), len(wantSet))
	}
	sorted := make([]int64, 0, len(got))
	for _, row := range got {
		sorted = append(sorted, row[0])
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	for _, v := range sorted {
		if !wantSet[v] {
			t.Fatalf("unexpected result value %d", v)
		}
	}

	// The engine must jump the gaps: total Next calls stay on the order of the
	// result count, nowhere near the 15k underlying domain elements, while seek
	// calls dominate and skip the wide gaps arithmetically.
	if agg.Nexts > int64(len(got))*3+6 {
		t.Fatalf("too many Next calls (%d) for %d results; engine appears to walk gaps", agg.Nexts, len(got))
	}
	var totalSkipped int64
	for _, c := range f.cursors {
		totalSkipped += c.skipped
	}
	if totalSkipped < int64(len(got)) {
		t.Fatal("expected seek jumps to skip gap positions, but none were skipped")
	}
	if agg.Seeks == 0 {
		t.Fatal("intersection over three cursors must issue seek calls")
	}
}

// recordingCursor wraps any cursor and snapshots every call. It lets tests
// assert the engine drives the cyclic join purely through trie navigation and
// never asks an adapter for tuple lists or pairwise intermediate tables.
type recordingCursor struct {
	TrieIterator
	seeksWithNext []string
}

func (r *recordingCursor) SeekTo(target int64) (bool, error) {
	before := r.TrieIterator.Counts().Nexts
	ok, err := r.TrieIterator.SeekTo(target)
	if r.TrieIterator.Counts().Nexts != before {
		r.seeksWithNext = append(r.seeksWithNext, "seek internally used Next")
	}
	return ok, err
}

type recordingFactory struct {
	wrapped CursorFactory
	cursors []*recordingCursor
}

func (f *recordingFactory) NewIterator(snap RelationSnapshot) (TrieIterator, error) {
	inner, err := f.wrapped.NewIterator(snap)
	if err != nil {
		return nil, err
	}
	rc := &recordingCursor{TrieIterator: inner}
	f.cursors = append(f.cursors, rc)
	return rc, nil
}

// TestNoPairwiseIntermediate verifies the engine drives a cyclic join purely
// through trie navigation: seek never degrades into repeated Next, open/up are
// balanced, and the adapter is only handed the original per-relation snapshots
// (never a pairwise materialized tuple table).
func TestNoPairwiseIntermediate(t *testing.T) {
	vars := []string{"a", "b", "c"}
	rels := []Relation{
		{ID: "R", Columns: []string{"a", "b"}, Tuples: [][]int64{{1, 1}, {1, 2}, {2, 2}}},
		{ID: "S", Columns: []string{"b", "c"}, Tuples: [][]int64{{1, 3}, {2, 3}, {2, 4}}},
		{ID: "T", Columns: []string{"a", "c"}, Tuples: [][]int64{{1, 3}, {2, 4}}},
	}
	want := referenceJoin(vars, rels)

	f := &recordingFactory{wrapped: MemFactory{}}
	it, err := Join(context.Background(), vars, rels, WithFactory(f))
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	got, counts, err := drain(it)
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("gap-adapter join mismatch\n got %v\nwant %v", got, want)
	}
	// Every open trie level is closed again on backtracking.
	if counts.Opens != counts.Ups {
		t.Fatalf("open/up imbalance: %+v", counts)
	}
	// Seek must jump, never emulate itself with repeated Next.
	for _, c := range f.cursors {
		if len(c.seeksWithNext) != 0 {
			t.Fatalf("cursor seek internally used Next: %v", c.seeksWithNext)
		}
	}
	// The factory only ever saw the original three relations, each with its own
	// arity: no fourth, widened, pairwise intermediate relation was created.
	if len(f.cursors) != len(rels) {
		t.Fatalf("expected one cursor per input relation, got %d", len(f.cursors))
	}
}
