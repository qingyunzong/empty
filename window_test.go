package telemetry

import (
	"errors"
	"fmt"
	"math"
	"math/rand"
	"sort"
	"testing"
)

func mustWindow(t *testing.T, bounds []int64, cap int) *Window {
	t.Helper()
	w, err := NewWindow(bounds, cap)
	if err != nil {
		t.Fatalf("NewWindow: %v", err)
	}
	return w
}

func TestRejectsUnsortedBoundaries(t *testing.T) {
	if _, err := NewWindow([]int64{10, 5}, 0); err == nil {
		t.Fatal("expected error for non-ascending boundaries")
	}
	if _, err := NewWindow([]int64{5, 5}, 0); err == nil {
		t.Fatal("expected error for duplicate boundaries")
	}
}

func TestDuplicateID(t *testing.T) {
	w := mustWindow(t, []int64{10, 20}, 0)
	if err := w.Add("a", 5); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := w.Add("a", 5); err != nil {
		t.Fatalf("idempotent re-add should succeed, got %v", err)
	}
	if w.Len() != 1 {
		t.Fatalf("idempotent re-add changed length to %d", w.Len())
	}
	err := w.Add("a", 7)
	if !errors.Is(err, ErrConflictingValue) {
		t.Fatalf("expected ErrConflictingValue, got %v", err)
	}
	if w.Len() != 1 {
		t.Fatalf("conflicting add changed length to %d", w.Len())
	}
}

func TestRetract(t *testing.T) {
	w := mustWindow(t, []int64{10, 20}, 0)
	w.Add("a", 5)
	w.Add("b", 15)
	if !w.Retract("a") {
		t.Fatal("Retract(a) = false, want true")
	}
	if w.Retract("a") {
		t.Fatal("second Retract(a) = true, want false")
	}
	if w.Retract("missing") {
		t.Fatal("Retract(missing) = true, want false")
	}
	if w.Len() != 1 {
		t.Fatalf("Len = %d, want 1", w.Len())
	}
	iv, ok := w.Quantile(0.5)
	if !ok || iv != (Interval{Lo: 10, Hi: 20, HasLo: true, HasHi: true}) {
		t.Fatalf("Quantile after retract = %v, %v", iv, ok)
	}
	// Re-adding a retracted ID with a new value must be accepted.
	if err := w.Add("a", 99); err != nil {
		t.Fatalf("re-add after retract: %v", err)
	}
}

func TestWindowSlides(t *testing.T) {
	w := mustWindow(t, []int64{10, 20}, 3)
	w.Add("a", 1)
	w.Add("b", 15)
	w.Add("c", 25)
	w.Add("d", 2) // evicts "a"
	if w.Len() != 3 {
		t.Fatalf("Len = %d, want 3", w.Len())
	}
	if w.Retract("a") {
		t.Fatal("evicted id still retractable")
	}
	// Retracted samples must not count toward eviction order.
	w.Retract("b")
	w.Add("e", 3) // window: c, d, e
	w.Add("f", 4) // evicts "c"
	if w.Retract("c") {
		t.Fatal("oldest live sample not evicted first")
	}
	if !w.Retract("d") || !w.Retract("e") || !w.Retract("f") {
		t.Fatal("live samples missing after slide")
	}
	if w.Len() != 0 {
		t.Fatalf("Len = %d, want 0", w.Len())
	}
}

func TestQuantileEdgeCases(t *testing.T) {
	w := mustWindow(t, []int64{10, 20}, 0)
	if _, ok := w.Quantile(0.5); ok {
		t.Fatal("quantile of empty window should fail")
	}
	w.Add("a", 5)
	for _, q := range []float64{0, -1, 1.5, math.NaN()} {
		if _, ok := w.Quantile(q); ok {
			t.Fatalf("q=%v should be rejected", q)
		}
	}
	iv, ok := w.Quantile(1)
	if !ok || iv != (Interval{Hi: 10, HasHi: true}) {
		t.Fatalf("single sample in first bucket: got %v", iv)
	}
}

func TestQuantileBucketIntervals(t *testing.T) {
	w := mustWindow(t, []int64{10, 20, 30}, 0)
	// values: 5, 15, 25, 35 -> one per bucket
	for i, v := range []int64{5, 15, 25, 35} {
		w.Add(fmt.Sprintf("id%d", i), v)
	}
	cases := []struct {
		q    float64
		want Interval
	}{
		{0.01, Interval{Hi: 10, HasHi: true}},
		{0.25, Interval{Hi: 10, HasHi: true}},
		{0.26, Interval{Lo: 10, Hi: 20, HasLo: true, HasHi: true}},
		{0.5, Interval{Lo: 10, Hi: 20, HasLo: true, HasHi: true}},
		{0.75, Interval{Lo: 20, Hi: 30, HasLo: true, HasHi: true}},
		{1.0, Interval{Lo: 30, HasLo: true}},
	}
	for _, c := range cases {
		got, ok := w.Quantile(c.q)
		if !ok || got != c.want {
			t.Errorf("Quantile(%v) = %v, %v; want %v", c.q, got, ok, c.want)
		}
	}
}

// refModel is an independent reference implementation tracking the live
// multiset with the same sliding-window semantics.
type refModel struct {
	cap   int
	live  map[string]int64
	order []string
}

func newRefModel(cap int) *refModel {
	return &refModel{cap: cap, live: make(map[string]int64)}
}

func (m *refModel) add(id string, v int64) {
	if _, ok := m.live[id]; ok {
		return
	}
	for m.cap > 0 && len(m.live) >= m.cap {
		oldest := m.order[0]
		m.order = m.order[1:]
		delete(m.live, oldest)
	}
	m.live[id] = v
	m.order = append(m.order, id)
}

func (m *refModel) retract(id string) {
	delete(m.live, id)
}

func (m *refModel) sorted() []int64 {
	vs := make([]int64, 0, len(m.live))
	for _, v := range m.live {
		vs = append(vs, v)
	}
	sort.Slice(vs, func(i, j int) bool { return vs[i] < vs[j] })
	return vs
}

func bucketInterval(bounds []int64, v int64) Interval {
	i := sort.Search(len(bounds), func(i int) bool { return v <= bounds[i] })
	var iv Interval
	if i > 0 {
		iv.Lo, iv.HasLo = bounds[i-1], true
	}
	if i < len(bounds) {
		iv.Hi, iv.HasHi = bounds[i], true
	}
	return iv
}

func TestRandomizedAgainstSortedMultiset(t *testing.T) {
	bounds := []int64{-100, -10, 0, 10, 100}
	quantiles := []float64{0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1.0}

	for _, seed := range []int64{1, 2, 3, 42, 2026} {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			const capacity = 64
			const idPool = 96 // > capacity to force evictions and re-adds
			w := mustWindow(t, bounds, capacity)
			ref := newRefModel(capacity)
			known := make(map[string]int64) // id -> value last accepted by w

			for step := 0; step < 4000; step++ {
				id := fmt.Sprintf("id%d", rng.Intn(idPool))
				switch rng.Intn(3) {
				case 0, 1: // add
					v := int64(rng.Intn(401) - 200)
					err := w.Add(id, v)
					if prev, ok := known[id]; ok {
						if prev != v {
							if !errors.Is(err, ErrConflictingValue) {
								t.Fatalf("step %d: conflicting add accepted", step)
							}
							break
						}
					}
					if err != nil {
						t.Fatalf("step %d: unexpected add error: %v", step, err)
					}
					// Recompute known from the library's perspective: the add
					// may have evicted the oldest live id.
					ref.add(id, v)
					known = map[string]int64{}
					for k, val := range ref.live {
						known[k] = val
					}
				default: // retract
					if w.Retract(id) {
						ref.retract(id)
						delete(known, id)
					}
				}

				if w.Len() != len(ref.live) {
					t.Fatalf("step %d: Len=%d, ref=%d", step, w.Len(), len(ref.live))
				}

				sorted := ref.sorted()
				for _, q := range quantiles {
					iv, ok := w.Quantile(q)
					if len(sorted) == 0 {
						if ok {
							t.Fatalf("step %d: quantile on empty window succeeded", step)
						}
						continue
					}
					if !ok {
						t.Fatalf("step %d: Quantile(%v) failed on %d samples", step, q, len(sorted))
					}
					rank := int(math.Ceil(q * float64(len(sorted))))
					if rank < 1 {
						rank = 1
					}
					trueVal := sorted[rank-1]
					if !iv.Contains(trueVal) {
						t.Fatalf("step %d: Quantile(%v)=%v does not cover true rank value %d",
							step, q, iv, trueVal)
					}
					// Narrowest guarantee: the interval must be exactly the
					// bucket containing the true rank value.
					if want := bucketInterval(bounds, trueVal); iv != want {
						t.Fatalf("step %d: Quantile(%v)=%v, want narrowest bucket %v",
							step, q, iv, want)
					}
				}
			}
		})
	}
}
