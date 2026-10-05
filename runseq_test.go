package runseq

import (
	"errors"
	"math"
	"math/rand"
	"reflect"
	"slices"
	"testing"
)

// --- naive model -----------------------------------------------------------

// modelApply applies op to a plain slice (the naive reference model) and
// returns the new slice.
func modelApply(m []int, op Op[int]) []int {
	off := int(op.Off)
	switch op.Kind {
	case OpInsert:
		out := make([]int, 0, len(m)+len(op.Values))
		out = append(out, m[:off]...)
		out = append(out, op.Values...)
		out = append(out, m[off:]...)
		return out
	case OpDelete:
		out := make([]int, 0, len(m)-int(op.Len))
		out = append(out, m[:off]...)
		out = append(out, m[off+int(op.Len):]...)
		return out
	case OpReplace:
		out := append([]int(nil), m...)
		copy(out[off:], op.Values)
		return out
	}
	panic("bad op kind")
}

// checkMerged verifies the Seq invariant: no two adjacent runs share a value
// and every run has positive length.
func checkMerged[T comparable](t *testing.T, s *Seq[T]) {
	t.Helper()
	var sum int64
	for i, r := range s.runs {
		if r.n <= 0 {
			t.Fatalf("run %d has non-positive length %d", i, r.n)
		}
		if i > 0 && s.runs[i-1].val == r.val {
			t.Fatalf("adjacent runs %d and %d both have value %v", i-1, i, r.val)
		}
		sum += r.n
	}
	if sum != s.total {
		t.Fatalf("run lengths sum to %d, total is %d", sum, s.total)
	}
}

func checkEqual(t *testing.T, s *Seq[int], model []int) {
	t.Helper()
	checkMerged(t, s)
	if s.Len() != int64(len(model)) {
		t.Fatalf("len mismatch: seq=%d model=%d", s.Len(), len(model))
	}
	got := s.Slice()
	if !slices.Equal(got, model) {
		t.Fatalf("content mismatch:\n seq=%v\nmodel=%v", got, model)
	}
}

// --- deterministic unit tests ----------------------------------------------

func TestFromSliceMergesAdjacent(t *testing.T) {
	s := FromSlice([]int{1, 1, 2, 2, 2, 1, 3, 3})
	if s.Runs() != 4 {
		t.Fatalf("expected 4 runs, got %d", s.Runs())
	}
	if got := s.Slice(); !reflect.DeepEqual(got, []int{1, 1, 2, 2, 2, 1, 3, 3}) {
		t.Fatalf("got %v", got)
	}
	if s.Len() != 8 {
		t.Fatalf("len=%d", s.Len())
	}
}

func TestInsertMergesAtBothSeams(t *testing.T) {
	s := FromSlice([]int{1, 1, 2, 2})
	if _, err := s.Insert(2, []int{1, 1}); err != nil { // 1 1 [1 1] 2 2
		t.Fatal(err)
	}
	checkMerged(t, s)
	if s.Runs() != 2 || s.Len() != 6 {
		t.Fatalf("runs=%d len=%d", s.Runs(), s.Len())
	}
	if got := s.Slice(); !reflect.DeepEqual(got, []int{1, 1, 1, 1, 2, 2}) {
		t.Fatalf("got %v", got)
	}
}

func TestDeleteSplitsRun(t *testing.T) {
	s := FromSlice([]int{5, 5, 5, 5})
	inv, err := s.Delete(1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Slice(); !reflect.DeepEqual(got, []int{5, 5}) {
		t.Fatalf("got %v", got)
	}
	if inv.Kind != OpInsert || inv.Off != 1 || !reflect.DeepEqual(inv.Values, []int{5, 5}) {
		t.Fatalf("inverse=%v", inv)
	}
	if _, err := s.Apply(inv); err != nil {
		t.Fatal(err)
	}
	if got := s.Slice(); !reflect.DeepEqual(got, []int{5, 5, 5, 5}) {
		t.Fatalf("after undo got %v", got)
	}
	if s.Runs() != 1 {
		t.Fatalf("undo did not re-merge, runs=%d", s.Runs())
	}
}

func TestReplaceInverseRoundTrip(t *testing.T) {
	s := FromSlice([]int{1, 2, 3, 4, 5})
	inv, err := s.Replace(1, []int{9, 9, 9})
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Slice(); !reflect.DeepEqual(got, []int{1, 9, 9, 9, 5}) {
		t.Fatalf("got %v", got)
	}
	if inv.Kind != OpReplace || inv.Off != 1 || !reflect.DeepEqual(inv.Values, []int{2, 3, 4}) {
		t.Fatalf("inverse=%v", inv)
	}
	if _, err := s.Apply(inv); err != nil {
		t.Fatal(err)
	}
	if got := s.Slice(); !reflect.DeepEqual(got, []int{1, 2, 3, 4, 5}) {
		t.Fatalf("after undo got %v", got)
	}
}

func TestInsertInverseIsDelete(t *testing.T) {
	s := FromSlice([]int{1, 2, 3})
	inv, err := s.Insert(1, []int{7, 8})
	if err != nil {
		t.Fatal(err)
	}
	if inv.Kind != OpDelete || inv.Off != 1 || inv.Len != 2 {
		t.Fatalf("inverse=%v", inv)
	}
	if _, err := s.Apply(inv); err != nil {
		t.Fatal(err)
	}
	if got := s.Slice(); !reflect.DeepEqual(got, []int{1, 2, 3}) {
		t.Fatalf("after undo got %v", got)
	}
}

func TestEmptyOpsAreNoOps(t *testing.T) {
	s := FromSlice([]int{1, 2})
	if _, err := s.Insert(0, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Delete(2, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Replace(1, nil); err != nil {
		t.Fatal(err)
	}
	if got := s.Slice(); !reflect.DeepEqual(got, []int{1, 2}) {
		t.Fatalf("got %v", got)
	}
}

func TestOutOfRange(t *testing.T) {
	s := FromSlice([]int{1, 2, 3})
	cases := []Op[int]{
		{Kind: OpInsert, Off: -1, Values: []int{1}},
		{Kind: OpInsert, Off: 4, Values: []int{1}},
		{Kind: OpDelete, Off: -1, Len: 1},
		{Kind: OpDelete, Off: 0, Len: -1},
		{Kind: OpDelete, Off: 2, Len: 2},
		{Kind: OpDelete, Off: 4, Len: 0},
		{Kind: OpReplace, Off: 1, Values: []int{1, 2, 3}},
		{Kind: OpReplace, Off: -1, Values: []int{1}},
	}
	for i, op := range cases {
		if _, err := s.Apply(op); !errors.Is(err, ErrOutOfRange) {
			t.Fatalf("case %d (%v): expected ErrOutOfRange, got %v", i, op, err)
		}
	}
	if got := s.Slice(); !reflect.DeepEqual(got, []int{1, 2, 3}) {
		t.Fatalf("sequence mutated by failed ops: %v", got)
	}
}

// --- 64-bit offsets and overflow -------------------------------------------

// hugeSeq builds a sequence with a single run of n copies of v without
// materializing n elements.
func hugeSeq(v int, n int64) *Seq[int] {
	return &Seq[int]{runs: []run[int]{{val: v, n: n}}, total: n}
}

func TestHugeOffsets(t *testing.T) {
	const big = int64(1) << 62
	s := hugeSeq(7, big)
	if got := s.At(big - 1); got != 7 {
		t.Fatalf("At(%d)=%d", big-1, got)
	}
	// Insert near the far end; coordinates are int64 throughout.
	inv, err := s.Insert(big-1, []int{8, 8})
	if err != nil {
		t.Fatal(err)
	}
	if s.Len() != big+2 {
		t.Fatalf("len=%d", s.Len())
	}
	if got := s.At(big - 1); got != 8 {
		t.Fatalf("At(%d)=%d", big-1, got)
	}
	if got := s.At(big + 1); got != 7 {
		t.Fatalf("At(%d)=%d", big+1, got)
	}
	// Undo with the returned inverse and confirm the original state.
	if _, err := s.Apply(inv); err != nil {
		t.Fatal(err)
	}
	if s.Len() != big || s.Runs() != 1 {
		t.Fatalf("after undo len=%d runs=%d", s.Len(), s.Runs())
	}
}

func TestDeleteHugeRange(t *testing.T) {
	const big = int64(1) << 62
	s := hugeSeq(3, big)
	inv, err := s.Delete(big/2, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if s.Len() != big-1000 {
		t.Fatalf("len=%d", s.Len())
	}
	if inv.Kind != OpInsert || inv.Off != big/2 || len(inv.Values) != 1000 {
		t.Fatalf("inverse kind=%v off=%d nvals=%d", inv.Kind, inv.Off, len(inv.Values))
	}
	for _, v := range inv.Values {
		if v != 3 {
			t.Fatalf("inverse contains %d", v)
		}
	}
}

func TestDeleteTooLargeToInvert(t *testing.T) {
	s := hugeSeq(1, math.MaxInt64-1)
	if _, err := s.Delete(0, int64(1)<<40); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected ErrTooLarge, got %v", err)
	}
	if s.Len() != math.MaxInt64-1 {
		t.Fatalf("sequence mutated, len=%d", s.Len())
	}
}

func TestInsertOverflow(t *testing.T) {
	s := hugeSeq(1, math.MaxInt64-1)
	if _, err := s.Insert(0, []int{1, 1, 1}); !errors.Is(err, ErrOverflow) {
		t.Fatalf("expected ErrOverflow, got %v", err)
	}
	if s.Len() != math.MaxInt64-1 {
		t.Fatalf("sequence mutated by overflowing insert, len=%d", s.Len())
	}
	// Exactly filling to MaxInt64 is fine.
	if _, err := s.Insert(math.MaxInt64-1, []int{2}); err != nil {
		t.Fatal(err)
	}
	if s.Len() != math.MaxInt64 {
		t.Fatalf("len=%d", s.Len())
	}
}

// --- randomized cross-check against the naive model -------------------------

func TestRandomOpsMatchNaiveModel(t *testing.T) {
	for _, seed := range []int64{1, 2, 3, 42, 99, 2026} {
		t.Run("", func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			model := make([]int, 0, 8)
			for i := 0; i < rng.Intn(8); i++ {
				model = append(model, rng.Intn(3))
			}
			s := FromSlice(model)
			initial := append([]int(nil), model...)
			var inverses []Op[int]

			randVals := func() []int {
				n := rng.Intn(5)
				vs := make([]int, n)
				for i := range vs {
					vs[i] = rng.Intn(3)
				}
				return vs
			}

			for step := 0; step < 300; step++ {
				n := int64(len(model))
				var op Op[int]
				switch rng.Intn(3) {
				case 0:
					op = Op[int]{Kind: OpInsert, Off: rng.Int63n(n + 1), Values: randVals()}
				case 1:
					off := rng.Int63n(n + 1)
					op = Op[int]{Kind: OpDelete, Off: off, Len: rng.Int63n(n - off + 1)}
				case 2:
					vs := randVals()
					if int64(len(vs)) > n {
						vs = vs[:n]
					}
					var off int64
					if hi := n - int64(len(vs)); hi > 0 {
						off = rng.Int63n(hi + 1)
					}
					op = Op[int]{Kind: OpReplace, Off: off, Values: vs}
				}
				inv, err := s.Apply(op)
				if err != nil {
					t.Fatalf("step %d: op %v: %v", step, op, err)
				}
				model = modelApply(model, op)
				inverses = append(inverses, inv)
				checkEqual(t, s, model)
			}

			// Undo everything in reverse order; must restore the initial state.
			for i := len(inverses) - 1; i >= 0; i-- {
				inv := inverses[i]
				if _, err := s.Apply(inv); err != nil {
					t.Fatalf("undo %d: op %v: %v", i, inv, err)
				}
				model = modelApply(model, inv)
				checkEqual(t, s, model)
			}
			if !slices.Equal(model, initial) {
				t.Fatalf("after undo model=%v, want %v", model, initial)
			}
			checkEqual(t, s, initial)
		})
	}
}

func FuzzRandomOps(f *testing.F) {
	f.Add(int64(7))
	f.Fuzz(func(t *testing.T, seed int64) {
		rng := rand.New(rand.NewSource(seed))
		var model []int
		s := New[int]()
		for step := 0; step < 100; step++ {
			n := int64(len(model))
			var op Op[int]
			switch rng.Intn(3) {
			case 0:
				vs := []int{rng.Intn(2)}
				op = Op[int]{Kind: OpInsert, Off: rng.Int63n(n + 1), Values: vs}
			case 1:
				off := rng.Int63n(n + 1)
				op = Op[int]{Kind: OpDelete, Off: off, Len: rng.Int63n(n - off + 1)}
			case 2:
				if n == 0 {
					continue
				}
				op = Op[int]{Kind: OpReplace, Off: rng.Int63n(n), Values: []int{rng.Intn(2)}}
			}
			if _, err := s.Apply(op); err != nil {
				t.Fatalf("step %d: op %v: %v", step, op, err)
			}
			model = modelApply(model, op)
			checkEqual(t, s, model)
		}
	})
}
