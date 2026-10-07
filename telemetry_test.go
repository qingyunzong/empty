package telemetry

import (
	"errors"
	"fmt"
	"math"
	"math/rand"
	"sort"
	"testing"
)

func mustNew(t *testing.T, bounds []int, size int) *Window {
	t.Helper()
	w, err := New(bounds, size)
	if err != nil {
		t.Fatalf("New(%v, %d): %v", bounds, size, err)
	}
	return w
}

func TestNewValidation(t *testing.T) {
	if _, err := New([]int{0, 10, 10}, 4); err == nil {
		t.Fatal("expected error for duplicate boundaries")
	}
	if _, err := New([]int{10, 0}, 4); err == nil {
		t.Fatal("expected error for unsorted boundaries")
	}
	if _, err := New([]int{0}, 0); err == nil {
		t.Fatal("expected error for non-positive size")
	}
}

func TestAddDuplicateID(t *testing.T) {
	w := mustNew(t, []int{0, 50, 100}, 8)
	if err := w.Add("a", 10); err != nil {
		t.Fatalf("first add: %v", err)
	}
	if err := w.Add("a", 10); err != nil {
		t.Fatalf("idempotent re-add should succeed: %v", err)
	}
	if w.Len() != 1 {
		t.Fatalf("idempotent re-add changed length: %d", w.Len())
	}
	err := w.Add("a", 20)
	if !errors.Is(err, ErrDuplicateID) {
		t.Fatalf("expected ErrDuplicateID, got %v", err)
	}
	iv, ok := w.Quantile(0.5)
	if !ok || !iv.Contains(10) {
		t.Fatalf("rejected add must not alter state, got %v ok=%v", iv, ok)
	}
}

func TestRetract(t *testing.T) {
	w := mustNew(t, []int{0, 25}, 8)
	for i, v := range []int{10, 20, 30} {
		if err := w.Add(fmt.Sprintf("id%d", i), v); err != nil {
			t.Fatal(err)
		}
	}
	if !w.Retract("id1") {
		t.Fatal("retract of live id returned false")
	}
	if w.Retract("id1") {
		t.Fatal("double retract returned true")
	}
	if w.Retract("missing") {
		t.Fatal("retract of unknown id returned true")
	}
	if w.Len() != 2 {
		t.Fatalf("len after retract = %d, want 2", w.Len())
	}
	iv, ok := w.Quantile(1.0)
	if !ok || !iv.Contains(30) || iv.Contains(20) {
		t.Fatalf("max after retract should be the bucket of 30, got %v", iv)
	}
}

func TestWindowSlidingEvictsOldest(t *testing.T) {
	w := mustNew(t, []int{0, 10, 100}, 3)
	for i, v := range []int{5, 15, 25, 35} {
		if err := w.Add(fmt.Sprintf("id%d", i), v); err != nil {
			t.Fatal(err)
		}
	}
	if w.Len() != 3 {
		t.Fatalf("len = %d, want 3", w.Len())
	}
	iv, ok := w.Quantile(0.01) // rank 1: smallest live value
	if !ok || !iv.Contains(15) || iv.Contains(5) {
		t.Fatalf("oldest value 5 should be evicted, min bucket = %v", iv)
	}
	// Evicted ID is forgotten: re-adding it with a new value must succeed.
	if err := w.Add("id0", 99); err != nil {
		t.Fatalf("re-adding evicted id should succeed: %v", err)
	}
}

func TestQuantileEmptyAndBadQ(t *testing.T) {
	w := mustNew(t, []int{0, 100}, 4)
	if _, ok := w.Quantile(0.5); ok {
		t.Fatal("quantile of empty window should report ok=false")
	}
	_ = w.Add("a", 1)
	for _, q := range []float64{0, -0.5, 1.01, 2} {
		if _, ok := w.Quantile(q); ok {
			t.Fatalf("q=%v should report ok=false", q)
		}
	}
}

func TestQuantileBucketIntervals(t *testing.T) {
	w := mustNew(t, []int{0, 10, 20, 30}, 16)
	for i, v := range []int{-5, 0, 3, 10, 17, 29, 42} {
		if err := w.Add(fmt.Sprintf("id%d", i), v); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		q    float64
		want Interval
	}{
		{0.01, Interval{HasLo: false, Hi: 0, HasHi: true}},         // -5
		{0.15, Interval{Lo: 0, HasLo: true, Hi: 10, HasHi: true}},  // 0 sits on a bound
		{0.5, Interval{Lo: 10, HasLo: true, Hi: 20, HasHi: true}},  // 10
		{0.85, Interval{Lo: 20, HasLo: true, Hi: 30, HasHi: true}}, // 29
		{1.0, Interval{Lo: 30, HasLo: true, HasHi: false}},         // 42
	}
	for _, c := range cases {
		got, ok := w.Quantile(c.q)
		if !ok {
			t.Fatalf("Quantile(%v) not ok", c.q)
		}
		if got != c.want {
			t.Fatalf("Quantile(%v) = %v, want %v", c.q, got, c.want)
		}
	}
}

// model is a reference sorted-multiset implementation of the same semantics.
type model struct {
	size   int
	order  []string
	values map[string]int
}

func newModel(size int) *model { return &model{size: size, values: map[string]int{}} }

func (m *model) add(id string, v int) error {
	if cur, ok := m.values[id]; ok {
		if cur != v {
			return ErrDuplicateID
		}
		return nil
	}
	if len(m.order) == m.size {
		delete(m.values, m.order[0])
		m.order = m.order[1:]
	}
	m.order = append(m.order, id)
	m.values[id] = v
	return nil
}

func (m *model) retract(id string) bool {
	if _, ok := m.values[id]; !ok {
		return false
	}
	delete(m.values, id)
	for i, cur := range m.order {
		if cur == id {
			m.order = append(m.order[:i], m.order[i+1:]...)
			break
		}
	}
	return true
}

func (m *model) rankValue(q float64) (int, bool) {
	n := len(m.values)
	if n == 0 {
		return 0, false
	}
	vals := make([]int, 0, n)
	for _, v := range m.values {
		vals = append(vals, v)
	}
	sort.Ints(vals)
	rank := int(math.Ceil(q * float64(n)))
	if rank < 1 {
		rank = 1
	}
	return vals[rank-1], true
}

func TestRandomOpsAgainstSortedMultiset(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	bounds := []int{-100, -10, 0, 10, 100}
	const size = 23
	w := mustNew(t, bounds, size)
	m := newModel(size)

	for step := 0; step < 20000; step++ {
		id := fmt.Sprintf("id%d", rng.Intn(4*size))
		switch rng.Intn(10) {
		case 0, 1: // retract
			gotOK := w.Retract(id)
			wantOK := m.retract(id)
			if gotOK != wantOK {
				t.Fatalf("step %d: Retract(%q) = %v, model %v", step, id, gotOK, wantOK)
			}
		case 2: // duplicate-id probe: re-add with a fresh random value
			v := rng.Intn(400) - 200
			gotErr := w.Add(id, v)
			wantErr := m.add(id, v)
			if (gotErr != nil) != (wantErr != nil) {
				t.Fatalf("step %d: Add(%q,%d) err=%v, model err=%v", step, id, v, gotErr, wantErr)
			}
		default: // plain add
			v := rng.Intn(400) - 200
			if err := w.Add(id, v); err != nil {
				if mErr := m.add(id, v); mErr == nil {
					t.Fatalf("step %d: window rejected add the model accepted", step)
				}
			} else if mErr := m.add(id, v); mErr != nil {
				t.Fatalf("step %d: model rejected add the window accepted", step)
			}
		}

		if w.Len() != len(m.values) {
			t.Fatalf("step %d: len %d, model %d", step, w.Len(), len(m.values))
		}

		// Verify quantiles against the sorted multiset at several ranks.
		for _, q := range []float64{0.01, 0.25, 0.5, 0.75, 0.99, 1.0} {
			iv, ok := w.Quantile(q)
			rv, mok := m.rankValue(q)
			if ok != mok {
				t.Fatalf("step %d q=%v: ok=%v, model ok=%v", step, q, ok, mok)
			}
			if !ok {
				continue
			}
			if !iv.Contains(rv) {
				t.Fatalf("step %d q=%v: interval %v does not cover true rank value %d", step, q, iv, rv)
			}
			// Narrowness: bounds must be adjacent configured boundaries
			// around the true rank value, i.e. exactly Locate(rv).
			if want := w.Locate(rv); iv != want {
				t.Fatalf("step %d q=%v: interval %v is not the narrowest bucket %v", step, q, iv, want)
			}
		}
	}
}

func TestQuantileCoversTrueRankAcrossRanks(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for trial := 0; trial < 200; trial++ {
		n := 1 + rng.Intn(50)
		w := mustNew(t, []int{-50, 0, 50}, n)
		vals := make([]int, n)
		for i := range vals {
			vals[i] = rng.Intn(201) - 100
			if err := w.Add(fmt.Sprintf("v%d", i), vals[i]); err != nil {
				t.Fatal(err)
			}
		}
		sort.Ints(vals)
		for r := 1; r <= n; r++ {
			q := (float64(r) - 0.5) / float64(n) // ceil(q*n) == r, float-safe
			iv, ok := w.Quantile(q)
			if !ok {
				t.Fatalf("trial %d rank %d/%d: not ok", trial, r, n)
			}
			if !iv.Contains(vals[r-1]) {
				t.Fatalf("trial %d rank %d/%d: %v misses true value %d", trial, r, n, iv, vals[r-1])
			}
		}
	}
}
