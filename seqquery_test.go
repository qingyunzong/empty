package seqquery

import (
	"math/rand"
	"testing"
)

func ids(r Result) []int {
	out := make([]int, len(r.Events))
	for i, e := range r.Events {
		out[i] = e.ID
	}
	return out
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestEmptyLibrary(t *testing.T) {
	lib := New()
	r := lib.Query(Query{MaxSpan: 10, MinTypes: 0})
	if !r.Empty() || r.Profit != 0 {
		t.Fatalf("got %+v, want empty segment with profit 0", r)
	}
}

func TestAllNegativeYieldsEmpty(t *testing.T) {
	lib := New()
	lib.Set([]Event{
		{ID: 1, Time: 0, Value: -3, Type: "a", Source: "s1", Inv: 1},
		{ID: 2, Time: 1, Value: -2, Type: "b", Source: "s2", Inv: 0},
	})
	r := lib.Query(Query{MaxSpan: 10, MinTypes: 0})
	if !r.Empty() || r.Profit != 0 {
		t.Fatalf("got ids=%v profit=%d, want empty segment", ids(r), r.Profit)
	}
}

func TestUnorderedInputSorted(t *testing.T) {
	events := []Event{
		{ID: 3, Time: 5, Value: 4, Type: "a", Source: "s3", Inv: 0},
		{ID: 1, Time: 1, Value: 2, Type: "a", Source: "s1", Inv: 1},
		{ID: 2, Time: 3, Value: 3, Type: "b", Source: "s2", Inv: 0},
	}
	lib := New()
	lib.Set(events)
	r := lib.Query(Query{MaxSpan: 10, MinTypes: 0})
	if got := ids(r); !equalInts(got, []int{1, 2, 3}) {
		t.Fatalf("got ids=%v, want [1 2 3]", got)
	}
	if r.Profit != 9 {
		t.Fatalf("profit=%d, want 9", r.Profit)
	}
}

func TestSpanConstraint(t *testing.T) {
	lib := New()
	lib.Set([]Event{
		{ID: 1, Time: 0, Value: 5, Type: "a", Source: "s1", Inv: 0},
		{ID: 2, Time: 8, Value: 5, Type: "a", Source: "s2", Inv: 0},
		{ID: 3, Time: 20, Value: 5, Type: "a", Source: "s3", Inv: 0},
	})
	r := lib.Query(Query{MaxSpan: 10, MinTypes: 0})
	if got := ids(r); !equalInts(got, []int{1, 2}) {
		t.Fatalf("got ids=%v, want [1 2]", got)
	}
}

func TestMinTypesConstraint(t *testing.T) {
	lib := New()
	lib.Set([]Event{
		{ID: 1, Time: 0, Value: 10, Type: "a", Source: "s1", Inv: 0},
		{ID: 2, Time: 1, Value: -4, Type: "b", Source: "s2", Inv: 0},
		{ID: 3, Time: 2, Value: -4, Type: "c", Source: "s3", Inv: 0},
	})
	// k=2 时单事件段 [1] 不合法，最优为 [1,2]（收益 6）。
	r := lib.Query(Query{MaxSpan: 10, MinTypes: 2})
	if got := ids(r); !equalInts(got, []int{1, 2}) {
		t.Fatalf("got ids=%v, want [1 2]", got)
	}
	if r.Profit != 6 {
		t.Fatalf("profit=%d, want 6", r.Profit)
	}
}

func TestSourceExclusion(t *testing.T) {
	lib := New()
	lib.Set([]Event{
		{ID: 1, Time: 0, Value: 5, Type: "a", Source: "s1", Inv: 0},
		{ID: 2, Time: 1, Value: 5, Type: "b", Source: "s1", Inv: 0}, // 与 1 来源冲突
		{ID: 3, Time: 2, Value: 5, Type: "c", Source: "s2", Inv: 0},
	})
	r := lib.Query(Query{MaxSpan: 10, MinTypes: 0})
	// 含 1 与 2 的段来源冲突；最优为 [2,3]（收益 10）。
	if got := ids(r); !equalInts(got, []int{2, 3}) {
		t.Fatalf("got ids=%v, want [2 3]", got)
	}
}

func TestInventoryNonNegative(t *testing.T) {
	lib := New()
	lib.Set([]Event{
		{ID: 1, Time: 0, Value: 5, Type: "a", Source: "s1", Inv: 2},
		{ID: 2, Time: 1, Value: 5, Type: "b", Source: "s2", Inv: -1},
		{ID: 3, Time: 2, Value: 5, Type: "c", Source: "s3", Inv: -2}, // 前缀库存 2-1-2 < 0
	})
	r := lib.Query(Query{MaxSpan: 10, MinTypes: 0})
	if got := ids(r); !equalInts(got, []int{1, 2}) {
		t.Fatalf("got ids=%v, want [1 2]", got)
	}
	want := []int64{2, 1}
	if !equalInt64s(r.PrefixInv, want) {
		t.Fatalf("PrefixInv=%v, want %v", r.PrefixInv, want)
	}
}

func equalInt64s(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestTieBreakShorterSegment(t *testing.T) {
	lib := New()
	lib.Set([]Event{
		{ID: 1, Time: 0, Value: 3, Type: "a", Source: "s1", Inv: 0},
		{ID: 2, Time: 1, Value: 0, Type: "b", Source: "s2", Inv: 0},
	})
	// [1] 与 [1,2] 收益同为 3，更短的 [1] 胜出。
	r := lib.Query(Query{MaxSpan: 4, MinTypes: 0})
	if got := ids(r); !equalInts(got, []int{1}) {
		t.Fatalf("got ids=%v, want [1]", got)
	}
}

func TestTieBreakEarlierStart(t *testing.T) {
	lib := New()
	lib.Set([]Event{
		{ID: 1, Time: 0, Value: 3, Type: "a", Source: "s1", Inv: 0},
		{ID: 2, Time: 5, Value: 3, Type: "b", Source: "s2", Inv: 0},
	})
	// [1] 与 [2] 收益、长度相同，开始更早的 [1] 胜出。
	r := lib.Query(Query{MaxSpan: 4, MinTypes: 0})
	if got := ids(r); !equalInts(got, []int{1}) {
		t.Fatalf("got ids=%v, want [1]", got)
	}
}

func TestTieBreakSmallerIDs(t *testing.T) {
	lib := New()
	lib.Set([]Event{
		{ID: 5, Time: 0, Value: 2, Type: "a", Source: "s1", Inv: 0},
		{ID: 3, Time: 0, Value: 2, Type: "b", Source: "s1", Inv: 0},
	})
	// 两事件来源相同，段 [3,5] 非法；单事件段 [3] 与 [5] 收益、长度、
	// 开始时间全同，ID 更小的 [3] 胜出。
	r := lib.Query(Query{MaxSpan: 0, MinTypes: 0})
	if got := ids(r); !equalInts(got, []int{3}) {
		t.Fatalf("got ids=%v, want [3]", got)
	}
}

func TestCertificate(t *testing.T) {
	events := []Event{
		{ID: 1, Time: 0, Value: 4, Type: "a", Source: "s1", Inv: 3},
		{ID: 2, Time: 1, Value: 2, Type: "b", Source: "s2", Inv: -1},
		{ID: 3, Time: 2, Value: 1, Type: "a", Source: "s3", Inv: 0},
	}
	lib := New()
	lib.Set(events)
	r := lib.Query(Query{MaxSpan: 5, MinTypes: 2})
	if err := CheckCertificate(events, Query{MaxSpan: 5, MinTypes: 2}, r); err != nil {
		t.Fatalf("certificate invalid: %v", err)
	}
	if got := r.Coverage["a"]; !equalInts(got, []int{1, 3}) {
		t.Fatalf("coverage[a]=%v, want [1 3]", got)
	}
	if got := r.Coverage["b"]; !equalInts(got, []int{2}) {
		t.Fatalf("coverage[b]=%v, want [2]", got)
	}
	if !equalInt64s(r.PrefixInv, []int64{3, 2, 2}) {
		t.Fatalf("PrefixInv=%v, want [3 2 2]", r.PrefixInv)
	}
}

func TestCorrectionRevokesOldResult(t *testing.T) {
	lib := New()
	lib.Set([]Event{
		{ID: 1, Time: 0, Value: 5, Type: "a", Source: "s1", Inv: 0},
	})
	old := lib.Query(Query{MaxSpan: 10, MinTypes: 0})
	if !lib.Valid(old) {
		t.Fatal("fresh result should be valid")
	}
	lib.Correct([]Event{
		{ID: 2, Time: 0, Value: 7, Type: "a", Source: "s1", Inv: 0},
	})
	if lib.Valid(old) {
		t.Fatal("old result should be revoked after correction")
	}
	r := lib.Query(Query{MaxSpan: 10, MinTypes: 0})
	if !lib.Valid(r) {
		t.Fatal("new result should be valid")
	}
	if got := ids(r); !equalInts(got, []int{2}) || r.Profit != 7 {
		t.Fatalf("got ids=%v profit=%d, want [2] profit 7", got, r.Profit)
	}
}

func TestBruteForceAgreement(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	types := []string{"a", "b", "c"}
	sources := []string{"s0", "s1", "s2", "s3"}
	for trial := 0; trial < 3000; trial++ {
		n := rng.Intn(13) // 小规模：0..12 事件
		events := make([]Event, n)
		for i := range events {
			events[i] = Event{
				ID:     i,
				Time:   int64(rng.Intn(20)),
				Value:  int64(rng.Intn(14) - 5),
				Type:   types[rng.Intn(len(types))],
				Source: sources[rng.Intn(len(sources))],
				Inv:    int64(rng.Intn(7) - 3),
			}
		}
		q := Query{MaxSpan: int64(rng.Intn(16)), MinTypes: rng.Intn(4)}
		lib := New()
		lib.Set(events)
		got := lib.Query(q)
		want := BruteForce(events, q, lib.Version())
		if got.Profit != want.Profit || !equalInts(ids(got), ids(want)) {
			t.Fatalf("trial %d: query=%+v events=%+v\ngot  ids=%v profit=%d\nwant ids=%v profit=%d",
				trial, q, events, ids(got), got.Profit, ids(want), want.Profit)
		}
		if err := CheckCertificate(events, q, got); err != nil {
			t.Fatalf("trial %d: certificate invalid: %v", trial, err)
		}
	}
}

func TestMaxEventsAccepted(t *testing.T) {
	rng := rand.New(rand.NewSource(30))
	events := make([]Event, MaxEvents)
	for i := range events {
		events[i] = Event{
			ID:     i,
			Time:   int64(rng.Intn(50)),
			Value:  int64(rng.Intn(11) - 5),
			Type:   []string{"a", "b", "c"}[rng.Intn(3)],
			Source: []string{"s0", "s1", "s2", "s3"}[rng.Intn(4)],
			Inv:    int64(rng.Intn(5) - 2),
		}
	}
	q := Query{MaxSpan: 12, MinTypes: 2}
	lib := New()
	lib.Set(events)
	got := lib.Query(q)
	want := BruteForce(events, q, lib.Version())
	if got.Profit != want.Profit || !equalInts(ids(got), ids(want)) {
		t.Fatalf("got ids=%v profit=%d, want ids=%v profit=%d",
			ids(got), got.Profit, ids(want), want.Profit)
	}
	if err := CheckCertificate(events, q, got); err != nil {
		t.Fatalf("certificate invalid: %v", err)
	}
}
