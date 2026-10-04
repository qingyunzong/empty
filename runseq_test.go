package runseq_test

import (
	"math"
	"math/rand"
	"reflect"
	"testing"

	"runseq"
)

func noErr(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func insert[T comparable](t *testing.T, s *runseq.Store[T], off int64, vals []T) runseq.Operation[T] {
	t.Helper()
	inv, err := s.Insert(off, vals)
	noErr(t, err)
	return inv
}

func del[T comparable](t *testing.T, s *runseq.Store[T], off, n int64) runseq.Operation[T] {
	t.Helper()
	inv, err := s.Delete(off, n)
	noErr(t, err)
	return inv
}

func replace[T comparable](t *testing.T, s *runseq.Store[T], off int64, vals []T) runseq.Operation[T] {
	t.Helper()
	inv, err := s.Replace(off, vals)
	noErr(t, err)
	return inv
}

func undo[T comparable](t *testing.T, s *runseq.Store[T], inv runseq.Operation[T]) {
	t.Helper()
	if _, err := s.Apply(inv); err != nil {
		t.Fatalf("undo failed: %v", err)
	}
}

func TestBasicOperations(t *testing.T) {
	s := runseq.New[int]()

	insert(t, s, 0, []int{1, 2, 2, 3})
	if got, want := s.Collect(), []int{1, 2, 2, 3}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after insert: got %v want %v", got, want)
	}

	// Coordinates refer to the current sequence.
	insert(t, s, 2, []int{9, 9})
	if got, want := s.Collect(), []int{1, 2, 9, 9, 2, 3}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after insert@2: got %v want %v", got, want)
	}

	del(t, s, 2, 2) // removes the two 9s
	if got, want := s.Collect(), []int{1, 2, 2, 3}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after delete: got %v want %v", got, want)
	}

	replace(t, s, 1, []int{7, 7, 7})
	if got, want := s.Collect(), []int{1, 7, 7, 7}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after replace: got %v want %v", got, want)
	}

	if got, want := s.Len(), int64(4); got != want {
		t.Fatalf("len: got %d want %d", got, want)
	}
	if v, ok := s.At(3); !ok || v != 7 {
		t.Fatalf("At(3): got %v,%v want 7,true", v, ok)
	}
	if _, ok := s.At(4); ok {
		t.Fatalf("At(4) should be out of range")
	}
}

func TestMerging(t *testing.T) {
	s := runseq.New[int]()
	insert(t, s, 0, []int{1, 1, 2, 2})
	if got := s.SpanCount(); got != 2 {
		t.Fatalf("spans: got %d want 2", got)
	}
	// Insert 1s at the seam so the run of 1s is extended, not fragmented.
	insert(t, s, 2, []int{1, 1})
	if got, want := s.Collect(), []int{1, 1, 1, 1, 2, 2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if got := s.SpanCount(); got != 2 {
		t.Fatalf("spans after bridging insert: got %d want 2", got)
	}
	// Delete the 1s so nothing remains but the 2-run; spans must merge.
	del(t, s, 0, 4)
	if got, want := s.Collect(), []int{2, 2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if got := s.SpanCount(); got != 1 {
		t.Fatalf("spans after merge: got %d want 1", got)
	}
	spans := s.Spans()
	if spans[0].Value != 2 || spans[0].Len != 2 {
		t.Fatalf("merged span: got %+v", spans[0])
	}
	// Replace with a value equal to its neighbours must collapse to one run.
	replace(t, s, 0, []int{2, 2})
	if got := s.SpanCount(); got != 1 {
		t.Fatalf("spans after replace: got %d want 1", got)
	}
}

func TestInverseRestoresState(t *testing.T) {
	s := runseq.New[int]()
	insert(t, s, 0, []int{1, 2, 2, 3, 3, 3})
	before := s.Collect()
	beforeSpans := s.Spans()

	undo(t, s, insert(t, s, 2, []int{9, 9, 9}))
	if got := s.Collect(); !reflect.DeepEqual(got, before) {
		t.Fatalf("after undo insert: got %v want %v", got, before)
	}

	undo(t, s, del(t, s, 1, 4))
	if got := s.Collect(); !reflect.DeepEqual(got, before) {
		t.Fatalf("after undo delete: got %v want %v", got, before)
	}

	undo(t, s, replace(t, s, 2, []int{5, 5}))
	if got := s.Collect(); !reflect.DeepEqual(got, before) {
		t.Fatalf("after undo replace: got %v want %v", got, before)
	}
	if got := s.Spans(); !reflect.DeepEqual(got, beforeSpans) {
		t.Fatalf("span structure changed after undos: got %v want %v", got, beforeSpans)
	}
}

// naive model helpers operating on a plain slice.

func naiveInsert(m []int, off int64, vals []int) []int {
	out := make([]int, 0, len(m)+len(vals))
	out = append(out, m[:off]...)
	out = append(out, vals...)
	out = append(out, m[off:]...)
	return out
}

func naiveDelete(m []int, off, n int64) []int {
	out := make([]int, 0, len(m)-int(n))
	out = append(out, m[:off]...)
	out = append(out, m[off+n:]...)
	return out
}

func naiveReplace(m []int, off int64, vals []int) []int {
	return naiveDelete(naiveInsert(m, off, vals), off+int64(len(vals)), int64(len(vals)))
}

func randVals(r *rand.Rand, n int) []int {
	out := make([]int, n)
	for i := range out {
		out[i] = r.Intn(3) // small alphabet forces frequent merges
	}
	return out
}

func TestRandomAgainstNaiveModel(t *testing.T) {
	r := rand.New(rand.NewSource(20261005))
	s := runseq.New[int]()
	model := []int{}
	var inverses []runseq.Operation[int]

	check := func(step int) {
		t.Helper()
		if got := s.Collect(); !reflect.DeepEqual(got, model) {
			t.Fatalf("step %d: store %v != model %v", step, got, model)
		}
		if s.Len() != int64(len(model)) {
			t.Fatalf("step %d: len %d != %d", step, s.Len(), len(model))
		}
		// Invariant: no adjacent equal spans, no empty spans.
		spans := s.Spans()
		var total int64
		for i, sp := range spans {
			if sp.Len <= 0 {
				t.Fatalf("step %d: empty span at %d", step, i)
			}
			if i > 0 && spans[i-1].Value == sp.Value {
				t.Fatalf("step %d: unmerged adjacent spans at %d", step, i)
			}
			total += sp.Len
		}
		if total != s.Len() {
			t.Fatalf("step %d: span total %d != len %d", step, total, s.Len())
		}
	}

	const steps = 2000
	for step := 0; step < steps; step++ {
		n := int64(len(model))
		var inv runseq.Operation[int]
		switch r.Intn(3) {
		case 0: // insert
			off := r.Int63n(n + 1)
			vals := randVals(r, r.Intn(8))
			inv = insert(t, s, off, vals)
			model = naiveInsert(model, off, vals)
		case 1: // delete
			if n == 0 {
				continue
			}
			off := r.Int63n(n)
			cnt := r.Int63n(n-off) + 1
			inv = del(t, s, off, cnt)
			model = naiveDelete(model, off, cnt)
		case 2: // replace
			if n == 0 {
				continue
			}
			off := r.Int63n(n)
			cnt := r.Int63n(min(n-off, 6)) + 1
			vals := randVals(r, int(cnt))
			inv = replace(t, s, off, vals)
			model = naiveReplace(model, off, vals)
		}
		inverses = append(inverses, inv)
		check(step)
	}

	// Undo everything in reverse order; must return to the empty sequence.
	for i := len(inverses) - 1; i >= 0; i-- {
		if _, err := s.Apply(inverses[i]); err != nil {
			t.Fatalf("undo step %d failed: %v", i, err)
		}
	}
	if got := s.Collect(); len(got) != 0 {
		t.Fatalf("after undoing all: got %v want empty", got)
	}
	if s.Len() != 0 || s.SpanCount() != 0 {
		t.Fatalf("store not empty after full undo: len=%d spans=%d", s.Len(), s.SpanCount())
	}
}

func TestBoundsAndOverflow(t *testing.T) {
	s := runseq.New[int]()
	insert(t, s, 0, []int{1, 2, 3})

	bad := []func() error{
		func() error { _, e := s.Insert(-1, []int{0}); return e },
		func() error { _, e := s.Insert(4, []int{0}); return e },
		func() error { _, e := s.Delete(-1, 1); return e },
		func() error { _, e := s.Delete(0, -1); return e },
		func() error { _, e := s.Delete(2, 2); return e },
		func() error { _, e := s.Delete(0, math.MaxInt64); return e },
		func() error { _, e := s.Replace(3, []int{0}); return e },
		func() error { _, e := s.InsertRepeat(0, 0, -5); return e },
		func() error { _, e := s.Slice(1, 5); return e },
	}
	for i, f := range bad {
		if err := f(); err == nil {
			t.Fatalf("case %d: expected error, got nil", i)
		}
	}
	// Failed operations must not modify the store.
	if got, want := s.Collect(), []int{1, 2, 3}; !reflect.DeepEqual(got, want) {
		t.Fatalf("store mutated by failed ops: got %v want %v", got, want)
	}

	// Build a huge run without materializing it.
	big := runseq.New[int]()
	if _, err := big.InsertRepeat(0, 7, math.MaxInt64-10); err != nil {
		t.Fatalf("InsertRepeat: %v", err)
	}
	if got := big.Len(); got != math.MaxInt64-10 {
		t.Fatalf("big len: got %d", got)
	}
	if _, err := big.Insert(0, make([]int, 11)); err == nil {
		t.Fatalf("expected overflow error on insert past MaxInt64")
	}
	if _, err := big.InsertRepeat(0, 7, 11); err == nil {
		t.Fatalf("expected overflow error on repeat insert past MaxInt64")
	}
	if _, err := big.InsertRepeat(0, 7, 10); err != nil {
		t.Fatalf("insert up to MaxInt64 should succeed: %v", err)
	}
	if big.Len() != math.MaxInt64 {
		t.Fatalf("len after max insert: got %d", big.Len())
	}
	// Deleting from the huge run and undoing must restore it.
	inv, err := big.Delete(5, 3)
	noErr(t, err)
	if big.Len() != math.MaxInt64-3 {
		t.Fatalf("len after delete: got %d", big.Len())
	}
	undo(t, big, inv)
	if big.Len() != math.MaxInt64 || big.SpanCount() != 1 {
		t.Fatalf("after undo: len=%d spans=%d", big.Len(), big.SpanCount())
	}
}

func TestSliceAndAt(t *testing.T) {
	s := runseq.New[string]()
	insert(t, s, 0, []string{"a", "a", "b", "c", "c", "c"})
	got, err := s.Slice(1, 4)
	noErr(t, err)
	if want := []string{"a", "b", "c", "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Slice: got %v want %v", got, want)
	}
	if v, ok := s.At(0); !ok || v != "a" {
		t.Fatalf("At(0): got %q,%v", v, ok)
	}
	if v, ok := s.At(5); !ok || v != "c" {
		t.Fatalf("At(5): got %q,%v", v, ok)
	}
}
