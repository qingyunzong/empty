package dataeng

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"reflect"
	"slices"
	"testing"
)

func TestProductOrderAndAntichainNormalization(t *testing.T) {
	a := Time{X: 0, Y: 1}
	b := Time{X: 1, Y: 0}
	if a.LessOrEqual(b) || b.LessOrEqual(a) {
		t.Fatalf("%s and %s must be incomparable", a, b)
	}
	if !a.LessThan(Time{X: 1, Y: 1}) {
		t.Fatal("expected (0,1) < (1,1)")
	}
	if Join(a, b) != (Time{X: 1, Y: 1}) {
		t.Fatalf("join = %s", Join(a, b))
	}
	if Meet(a, b) != (Time{}) {
		t.Fatalf("meet = %s", Meet(a, b))
	}

	got := NewAntichain(
		Time{X: 1, Y: 1},
		Time{X: 0, Y: 0},
		Time{X: 1, Y: 0},
		Time{X: 0, Y: 0},
		Time{X: 1, Y: 2},
	).Points()
	if !slices.Equal(got, []Time{{X: 0, Y: 0}}) {
		t.Fatalf("normalization = %v", got)
	}

	got = NewAntichain(
		Time{X: 1, Y: 0},
		Time{X: 0, Y: 1},
		Time{X: 1, Y: 1},
		Time{X: 0, Y: 1},
	).Points()
	if !slices.Equal(got, []Time{{X: 0, Y: 1}, {X: 1, Y: 0}}) {
		t.Fatalf("normalization = %v", got)
	}
}

func TestNewHostInitialState(t *testing.T) {
	if _, err := NewHost(0); !errors.Is(err, ErrNoInputs) {
		t.Fatalf("NewHost(0) error = %v", err)
	}
	h := newTestHost(t, 2)
	if h.InputCount() != 2 {
		t.Fatalf("input count = %d", h.InputCount())
	}
	if got := h.Since(); !slices.Equal(got, []Time{{X: 0, Y: 0}}) {
		t.Fatalf("initial since = %v", got)
	}
	for i := 0; i < 2; i++ {
		got, err := h.Frontier(i)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(got, []Time{{X: 0, Y: 0}}) {
			t.Fatalf("initial frontier %d = %v", i, got)
		}
	}
}

func TestCompactionFormula(t *testing.T) {
	since := NewAntichain(Time{X: 2, Y: 0}, Time{X: 0, Y: 3})
	tests := []struct {
		in   Time
		want Time
	}{
		{Time{X: 0, Y: 0}, Time{X: 0, Y: 0}},
		{Time{X: 1, Y: 1}, Time{X: 1, Y: 1}},
		{Time{X: 2, Y: 4}, Time{X: 2, Y: 4}},
	}
	for _, test := range tests {
		if got := since.Compact(test.in); got != test.want {
			t.Fatalf("compact(%s) = %s, want %s", test.in, got, test.want)
		}
	}

	since = NewAntichain(Time{X: 2, Y: 1})
	if got := since.Compact(Time{X: 0, Y: 0}); got != (Time{X: 2, Y: 1}) {
		t.Fatalf("compact = %s", got)
	}
}

func TestFrontierBlockersAndRegression(t *testing.T) {
	h := newTestHost(t, 2)
	if _, err := h.UpdateInt(0, "x", Time{X: 1, Y: 0}, 1); err != nil {
		t.Fatal(err)
	}
	out, err := h.AdvanceFrontier(0, []Time{{X: 1, Y: 0}, {X: 0, Y: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Delivered) != 0 {
		t.Fatalf("unexpected delivery: %v", out.Delivered)
	}

	out, err = h.RegisterQuery("blocked", Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Delivered) != 0 {
		t.Fatalf("query was delivered too early: %v", out.Delivered)
	}
	status, err := h.QueryStatus("blocked")
	if err != nil {
		t.Fatal(err)
	}
	wantBlockers := []Blocker{{Input: 1, Points: []Time{{X: 0, Y: 0}}}}
	if status.Complete || !status.Allowed {
		t.Fatalf("status = %+v", status)
	}
	if !reflect.DeepEqual(status.Blockers, wantBlockers) {
		t.Fatalf("blockers = %+v, want %+v", status.Blockers, wantBlockers)
	}
	if !slices.Equal(status.AllowedBy, []Time{{X: 0, Y: 0}}) {
		t.Fatalf("allowed by = %v", status.AllowedBy)
	}

	if _, err := h.RegisterQuery("blocked", Time{X: 9, Y: 9}); !errors.Is(err, ErrDuplicateQueryID) {
		t.Fatalf("duplicate error = %v", err)
	}

	if _, err := h.RegisterQuery("high", Time{X: 5, Y: 5}); err != nil {
		t.Fatal(err)
	}
	highStatus, err := h.QueryStatus("high")
	if err != nil {
		t.Fatal(err)
	}
	if len(highStatus.Blockers) != 2 {
		t.Fatalf("high blockers = %+v", highStatus.Blockers)
	}

	before, _ := h.Frontier(0)
	if _, err := h.AdvanceFrontier(0, []Time{{X: 0, Y: 0}}); !errors.Is(err, ErrFrontierRegression) {
		t.Fatalf("regression error = %v", err)
	}
	after, _ := h.Frontier(0)
	if !slices.Equal(before, after) {
		t.Fatalf("frontier changed after rejected advance: %v -> %v", before, after)
	}

	out, err = h.AdvanceFrontier(1, []Time{{X: 1, Y: 0}, {X: 0, Y: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Delivered) != 1 || out.Delivered[0].ID != "blocked" {
		t.Fatalf("delivered = %+v", out.Delivered)
	}
	checkWeights(t, out.Delivered[0].Weights, nil)
	if _, err := h.QueryStatus("blocked"); !errors.Is(err, ErrUnknownQueryID) {
		t.Fatalf("delivered query still live: %v", err)
	}
	if status, err := h.QueryStatus("high"); err != nil || status.Complete {
		t.Fatalf("high query should still be live and blocked: %+v, %v", status, err)
	}

	snapshotBefore := h.Snapshot()
	if _, err := h.UpdateInt(0, "bad", Time{}, 99); !errors.Is(err, ErrUpdateOutsideFrontier) {
		t.Fatalf("outside-frontier update error = %v", err)
	}
	if !reflect.DeepEqual(h.Snapshot(), snapshotBefore) {
		t.Fatal("rejected update changed host state")
	}
}

func TestEmptyFrontierEndsInput(t *testing.T) {
	h := newTestHost(t, 1)
	if _, err := h.AdvanceFrontier(0, nil); err != nil {
		t.Fatal(err)
	}
	if frontier, err := h.Frontier(0); err != nil || len(frontier) != 0 {
		t.Fatalf("frontier = %v, err = %v", frontier, err)
	}
	if _, err := h.UpdateInt(0, "x", Time{}, 1); !errors.Is(err, ErrInputEnded) {
		t.Fatalf("update after end error = %v", err)
	}
	if _, err := h.AdvanceFrontier(0, []Time{{X: 0, Y: 0}}); !errors.Is(err, ErrInputEnded) {
		t.Fatalf("restore after end error = %v", err)
	}
	if _, err := h.AdvanceFrontier(0, nil); err != nil {
		t.Fatalf("empty to empty error = %v", err)
	}

	out, err := h.RegisterQuery("ended", Time{X: 4, Y: 4})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Delivered) != 1 || out.Delivered[0].ID != "ended" {
		t.Fatalf("ended query = %+v", out.Delivered)
	}
	checkWeights(t, out.Delivered[0].Weights, nil)
}

func TestWeightCancellationAndMerging(t *testing.T) {
	h := newTestHost(t, 1)
	if _, err := h.UpdateInt(0, "a", Time{X: 1, Y: 1}, 5); err != nil {
		t.Fatal(err)
	}
	if _, err := h.UpdateInt(0, "a", Time{X: 1, Y: 1}, -5); err != nil {
		t.Fatal(err)
	}
	if records := h.Snapshot().Records; len(records) != 0 {
		t.Fatalf("canceled records remain: %+v", records)
	}

	for _, update := range []struct {
		key  string
		at   Time
		want int64
	}{
		{"b", Time{X: 0, Y: 1}, 7},
		{"b", Time{X: 1, Y: 0}, -3},
		{"c", Time{X: 1, Y: 1}, 2},
		{"c", Time{X: 1, Y: 0}, -2},
	} {
		if _, err := h.UpdateInt(0, update.key, update.at, update.want); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.AdvanceFrontier(0, nil); err != nil {
		t.Fatal(err)
	}
	out, err := h.RegisterQuery("sum", Time{X: 1, Y: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Delivered) != 1 {
		t.Fatalf("delivered = %+v", out.Delivered)
	}
	checkWeights(t, out.Delivered[0].Weights, map[string]int64{"b": 4})
}

func TestArbitraryPrecisionWeights(t *testing.T) {
	large, ok := new(big.Int).SetString("10000000000000000000000000000000000000007", 10)
	if !ok {
		t.Fatal("invalid test weight")
	}
	negative, ok := new(big.Int).SetString("-1000000000000000000000000000000", 10)
	if !ok {
		t.Fatal("invalid test weight")
	}

	h := newTestHost(t, 1)
	if _, err := h.Update(0, "big", Time{}, large); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Update(0, "big", Time{}, negative); err != nil {
		t.Fatal(err)
	}
	if _, err := h.AdvanceFrontier(0, nil); err != nil {
		t.Fatal(err)
	}
	out, err := h.RegisterQuery("big-query", Time{})
	if err != nil {
		t.Fatal(err)
	}
	want := new(big.Int).Add(large, negative)
	if got := out.Delivered[0].Weights["big"]; got == nil || got.Cmp(want) != 0 {
		t.Fatalf("big weight = %v, want %s", got, want)
	}

	h2 := newTestHost(t, 1)
	if _, err := h2.Update(0, "cancel", Time{}, large); err != nil {
		t.Fatal(err)
	}
	inverse := new(big.Int).Neg(large)
	if _, err := h2.Update(0, "cancel", Time{}, inverse); err != nil {
		t.Fatal(err)
	}
	if records := h2.Snapshot().Records; len(records) != 0 {
		t.Fatalf("arbitrary-precision cancellation left records: %+v", records)
	}
}

func TestQueryDeliveryOrderAndPartialOrder(t *testing.T) {
	h := newTestHost(t, 1)
	if _, err := h.RegisterQuery("low", Time{X: 0, Y: 5}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.RegisterQuery("high", Time{X: 5, Y: 0}); err != nil {
		t.Fatal(err)
	}

	out, err := h.AdvanceFrontier(0, []Time{{X: 5, Y: 0}})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Delivered) != 1 || out.Delivered[0].ID != "low" {
		t.Fatalf("lexicographically smaller time was not the only completion: %+v", out.Delivered)
	}
	status, err := h.QueryStatus("high")
	if err != nil || status.Complete {
		t.Fatalf("high status = %+v, err = %v", status, err)
	}

	out, err = h.AdvanceFrontier(0, []Time{{X: 6, Y: 0}})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Delivered) != 1 || out.Delivered[0].ID != "high" {
		t.Fatalf("delivered = %+v", out.Delivered)
	}

	h2 := newTestHost(t, 1)
	for _, reg := range []struct {
		id string
		q  Time
	}{
		{"b", Time{X: 1, Y: 0}},
		{"aa", Time{X: 0, Y: 2}},
		{"a", Time{X: 0, Y: 1}},
	} {
		if _, err := h2.RegisterQuery(reg.id, reg.q); err != nil {
			t.Fatal(err)
		}
	}
	out, err = h2.AdvanceFrontier(0, []Time{{X: 2, Y: 0}})
	if err != nil {
		t.Fatal(err)
	}
	if got := []string{out.Delivered[0].ID, out.Delivered[1].ID, out.Delivered[2].ID}; !slices.Equal(got, []string{"a", "aa", "b"}) {
		t.Fatalf("delivery order = %v", got)
	}
}

func TestSinceAdvanceIsAtomicAndClosedState(t *testing.T) {
	h := newTestHost(t, 1)
	for _, update := range []struct {
		key  string
		at   Time
		want int64
	}{
		{"k", Time{X: 0, Y: 1}, 3},
		{"k", Time{X: 1, Y: 1}, 5},
		{"k", Time{X: 2, Y: 0}, -1},
	} {
		if _, err := h.UpdateInt(0, update.key, update.at, update.want); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.AdvanceSince([]Time{{X: 1, Y: 0}, {X: 0, Y: 1}}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.RegisterQuery("keep", Time{X: 0, Y: 2}); err != nil {
		t.Fatal(err)
	}

	snapshotBefore := h.Snapshot()
	if _, err := h.AdvanceSince(nil); !errors.Is(err, ErrSinceRejectsRegisteredQueries) {
		t.Fatalf("empty since rejection error = %v", err)
	}
	if !reflect.DeepEqual(h.Snapshot(), snapshotBefore) {
		t.Fatal("rejected empty since advance changed state")
	}
	if _, err := h.AdvanceSince([]Time{{X: 2, Y: 2}}); !errors.Is(err, ErrSinceRejectsRegisteredQueries) {
		t.Fatalf("since rejection error = %v", err)
	}
	snapshotAfter := h.Snapshot()
	if !reflect.DeepEqual(snapshotBefore, snapshotAfter) {
		t.Fatalf("rejected since advance changed state:\nbefore %+v\nafter  %+v", snapshotBefore, snapshotAfter)
	}
	status, err := h.QueryStatus("keep")
	if err != nil || !status.Allowed || status.Complete {
		t.Fatalf("status after rejected advance = %+v, err = %v", status, err)
	}

	if _, err := h.RegisterQuery("alive", Time{X: 1, Y: 2}); err != nil {
		t.Fatal(err)
	}
	out, err := h.AdvanceFrontier(0, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := []string{out.Delivered[0].ID, out.Delivered[1].ID}; !slices.Equal(got, []string{"alive", "keep"}) {
		t.Fatalf("delivery order = %v", got)
	}
	checkWeights(t, out.Delivered[0].Weights, map[string]int64{"k": 8})
	checkWeights(t, out.Delivered[1].Weights, map[string]int64{"k": 3})

	if _, err := h.AdvanceSince(nil); err != nil {
		t.Fatal(err)
	}
	if len(h.Since()) != 0 || len(h.Snapshot().Records) != 0 {
		t.Fatalf("closed host not cleared: since=%v snapshot=%+v", h.Since(), h.Snapshot())
	}
	if _, err := h.UpdateInt(0, "k", Time{X: 9, Y: 9}, 1); !errors.Is(err, ErrHostClosed) {
		t.Fatalf("closed update error = %v", err)
	}
	if _, err := h.RegisterQuery("late", Time{X: 9, Y: 9}); !errors.Is(err, ErrHostClosed) {
		t.Fatalf("closed registration error = %v", err)
	}
	if _, err := h.AdvanceSince([]Time{{X: 3, Y: 3}}); !errors.Is(err, ErrHostClosed) {
		t.Fatalf("closed since error = %v", err)
	}
}

func TestSinceRegressionRejected(t *testing.T) {
	h := newTestHost(t, 1)
	if _, err := h.AdvanceSince([]Time{{X: 2, Y: 2}}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.AdvanceSince([]Time{{X: 1, Y: 1}}); !errors.Is(err, ErrSinceRegression) {
		t.Fatalf("regression error = %v", err)
	}
	if got := h.Since(); !slices.Equal(got, []Time{{X: 2, Y: 2}}) {
		t.Fatalf("since changed after rejected regression: %v", got)
	}
}

func TestSnapshotRoundTripAndContinuation(t *testing.T) {
	h := newTestHost(t, 2)
	if _, err := h.UpdateInt(0, "alpha", Time{X: 1, Y: 1}, 3); err != nil {
		t.Fatal(err)
	}
	if _, err := h.UpdateInt(0, "beta", Time{X: 0, Y: 2}, -1); err != nil {
		t.Fatal(err)
	}
	if _, err := h.UpdateInt(1, "alpha", Time{X: 2, Y: 0}, 5); err != nil {
		t.Fatal(err)
	}
	if _, err := h.AdvanceFrontier(0, []Time{{X: 2, Y: 0}, {X: 0, Y: 2}}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.AdvanceFrontier(1, []Time{{X: 1, Y: 3}}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.AdvanceSince([]Time{{X: 1, Y: 0}, {X: 0, Y: 1}}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.RegisterQuery("pending", Time{X: 0, Y: 3}); err != nil {
		t.Fatal(err)
	}

	data, err := json.Marshal(h)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := RestoreHost(data)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := restored.Snapshot(), h.Snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot mismatch:\ngot  %+v\nwant %+v", got, want)
	}
	var decoded Host
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if got, want := decoded.Snapshot(), h.Snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("UnmarshalJSON snapshot mismatch:\ngot  %+v\nwant %+v", got, want)
	}
	if err := json.Unmarshal([]byte(`{"version":2}`), &decoded); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatalf("invalid unmarshal error = %v", err)
	}
	if got, want := decoded.Snapshot(), h.Snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("failed UnmarshalJSON changed receiver:\ngot  %+v\nwant %+v", got, want)
	}
	if got, want := restored.PendingQueries(), h.PendingQueries(); !reflect.DeepEqual(got, want) {
		t.Fatalf("pending mismatch:\ngot  %+v\nwant %+v", got, want)
	}

	outOriginal, err := h.AdvanceFrontier(0, nil)
	if err != nil {
		t.Fatal(err)
	}
	outRestored, err := restored.AdvanceFrontier(0, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(outRestored, outOriginal) {
		t.Fatalf("delivery mismatch:\ngot  %+v\nwant %+v", outRestored, outOriginal)
	}
	checkWeights(t, outRestored.Delivered[0].Weights, map[string]int64{"beta": -1})

	if _, err := h.UpdateInt(1, "gamma", Time{X: 2, Y: 3}, 11); err != nil {
		t.Fatal(err)
	}
	if _, err := restored.UpdateInt(1, "gamma", Time{X: 2, Y: 3}, 11); err != nil {
		t.Fatal(err)
	}
	if got, want := restored.Snapshot(), h.Snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot after continuation mismatch:\ngot  %+v\nwant %+v", got, want)
	}
}

func TestClosedSnapshotRoundTrip(t *testing.T) {
	h := newTestHost(t, 1)
	if _, err := h.UpdateInt(0, "x", Time{X: 1, Y: 1}, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := h.AdvanceFrontier(0, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := h.AdvanceSince(nil); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(h)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := RestoreHost(data)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(restored.Snapshot(), h.Snapshot()) {
		t.Fatalf("closed snapshot mismatch")
	}
	if _, err := restored.RegisterQuery("q", Time{}); !errors.Is(err, ErrHostClosed) {
		t.Fatalf("restored closed registration error = %v", err)
	}
}

func TestInvalidSnapshotsRejected(t *testing.T) {
	tests := []struct {
		name string
		s    Snapshot
	}{
		{
			name: "version",
			s:    Snapshot{Version: 2, Inputs: []InputSnapshot{{Frontier: []Time{{}}}}},
		},
		{
			name: "no inputs",
			s:    Snapshot{Version: snapshotVersion},
		},
		{
			name: "closed with history",
			s: Snapshot{
				Version: snapshotVersion,
				Inputs:  []InputSnapshot{{Frontier: []Time{{}}}},
				Records: []RecordSnapshot{{Key: "k", Time: Time{}, Weight: "1"}},
			},
		},
		{
			name: "duplicate registration",
			s: Snapshot{
				Version: snapshotVersion,
				Inputs:  []InputSnapshot{{Frontier: []Time{{X: 1, Y: 0}, {X: 0, Y: 1}}}},
				Since:   []Time{{}},
				Registrations: []QuerySnapshot{
					{ID: "q", Query: Time{}},
					{ID: "q", Query: Time{}},
				},
			},
		},
		{
			name: "disallowed registration",
			s: Snapshot{
				Version:       snapshotVersion,
				Inputs:        []InputSnapshot{{Frontier: []Time{{X: 1, Y: 0}, {X: 0, Y: 1}}}},
				Since:         []Time{{X: 1, Y: 1}},
				Registrations: []QuerySnapshot{{ID: "q", Query: Time{}}},
			},
		},
		{
			name: "complete registration",
			s: Snapshot{
				Version:       snapshotVersion,
				Inputs:        []InputSnapshot{{Frontier: nil}},
				Since:         []Time{{}},
				Registrations: []QuerySnapshot{{ID: "q", Query: Time{}}},
			},
		},
		{
			name: "not compacted",
			s: Snapshot{
				Version: snapshotVersion,
				Inputs:  []InputSnapshot{{Frontier: []Time{{X: 2, Y: 2}}}},
				Since:   []Time{{X: 2, Y: 2}},
				Records: []RecordSnapshot{{Key: "k", Time: Time{}, Weight: "1"}},
			},
		},
		{
			name: "zero weight",
			s: Snapshot{
				Version: snapshotVersion,
				Inputs:  []InputSnapshot{{Frontier: []Time{{}}}},
				Since:   []Time{{}},
				Records: []RecordSnapshot{{Key: "k", Time: Time{}, Weight: "0"}},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := RestoreSnapshot(test.s); !errors.Is(err, ErrInvalidSnapshot) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

type gridRecord struct {
	input  int
	key    string
	at     Time
	weight int64
}

func TestCompactionQueryEquivalenceExhaustive(t *testing.T) {
	var records []gridRecord
	for x := uint64(0); x <= 3; x++ {
		for y := uint64(0); y <= 3; y++ {
			at := Time{X: x, Y: y}
			records = append(records,
				gridRecord{0, "alpha", at, int64(x*3+y) - 5},
				gridRecord{1, "alpha", at, int64(x+y) + 1},
				gridRecord{0, "beta", at, int64((x+y)%5) - 2},
				gridRecord{1, "beta", at, -(int64((x+y)%5) - 2)},
				gridRecord{0, "gamma", at, int64(x) - int64(y)},
				gridRecord{1, "gamma", at, int64(y) - int64(x)},
				gridRecord{0, "delta", at, int64((x*2+y*3)%7) - 3},
			)
		}
	}

	sinceCandidates := [][]Time{
		{{X: 0, Y: 0}},
		{{X: 1, Y: 0}},
		{{X: 0, Y: 1}},
		{{X: 1, Y: 1}},
		{{X: 2, Y: 1}},
		{{X: 1, Y: 2}},
		{{X: 1, Y: 0}, {X: 0, Y: 1}},
		{{X: 2, Y: 0}, {X: 0, Y: 2}},
		{{X: 3, Y: 0}, {X: 0, Y: 3}},
		{{X: 3, Y: 1}, {X: 1, Y: 3}},
	}

	for _, sincePoints := range sinceCandidates {
		label := fmt.Sprint(sincePoints)
		t.Run(label, func(t *testing.T) {
			h := newTestHost(t, 2)
			for _, record := range records {
				if _, err := h.UpdateInt(record.input, record.key, record.at, record.weight); err != nil {
					t.Fatalf("update %+v: %v", record, err)
				}
			}
			since := NewAntichain(sincePoints...)
			if _, err := h.AdvanceSince(sincePoints); err != nil {
				t.Fatal(err)
			}

			wantStored := make(map[recordKey]int64)
			for _, record := range records {
				stored := since.Compact(record.at)
				wantStored[recordKey{record.key, stored}] += record.weight
			}
			for key, weight := range wantStored {
				if weight == 0 {
					delete(wantStored, key)
				}
			}
			gotStored := make(map[recordKey]int64)
			for _, record := range h.Snapshot().Records {
				value, ok := new(big.Int).SetString(record.Weight, 10)
				if !ok {
					t.Fatalf("invalid stored weight %q", record.Weight)
				}
				gotStored[recordKey{record.Key, record.Time}] = value.Int64()
			}
			if !reflect.DeepEqual(gotStored, wantStored) {
				t.Fatalf("stored records mismatch:\ngot  %v\nwant %v", gotStored, wantStored)
			}

			if _, err := h.AdvanceFrontier(0, nil); err != nil {
				t.Fatal(err)
			}
			if _, err := h.AdvanceFrontier(1, nil); err != nil {
				t.Fatal(err)
			}

			for qx := uint64(0); qx <= 4; qx++ {
				for qy := uint64(0); qy <= 4; qy++ {
					q := Time{X: qx, Y: qy}
					id := fmt.Sprintf("q-%d-%d", qx, qy)
					if !since.Dominates(q) {
						if _, err := h.RegisterQuery(id, q); !errors.Is(err, ErrQueryNotAllowed) {
							t.Fatalf("q=%s allowed unexpectedly: %v", q, err)
						}
						continue
					}
					out, err := h.RegisterQuery(id, q)
					if err != nil {
						t.Fatalf("q=%s: %v", q, err)
					}
					if len(out.Delivered) != 1 || out.Delivered[0].ID != id {
						t.Fatalf("q=%s delivered = %+v", q, out.Delivered)
					}
					checkWeights(t, out.Delivered[0].Weights, expectedGridWeights(records, q))
				}
			}
		})
	}
}

func TestSequentialSinceCompactionMatchesDirect(t *testing.T) {
	var records []gridRecord
	for x := uint64(0); x <= 3; x++ {
		for y := uint64(0); y <= 3; y++ {
			records = append(records,
				gridRecord{0, "a", Time{X: x, Y: y}, int64(x*4+y) - 4},
				gridRecord{0, "b", Time{X: x, Y: y}, int64((x+y)%3) - 1},
			)
		}
	}

	h := newTestHost(t, 1)
	for _, record := range records {
		if _, err := h.UpdateInt(record.input, record.key, record.at, record.weight); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.AdvanceSince([]Time{{X: 1, Y: 1}, {X: 2, Y: 0}}); err != nil {
		t.Fatal(err)
	}
	finalSince := []Time{{X: 3, Y: 2}, {X: 2, Y: 3}}
	if _, err := h.AdvanceSince(finalSince); err != nil {
		t.Fatal(err)
	}
	if _, err := h.AdvanceFrontier(0, nil); err != nil {
		t.Fatal(err)
	}

	since := NewAntichain(finalSince...)
	for qx := uint64(0); qx <= 4; qx++ {
		for qy := uint64(0); qy <= 4; qy++ {
			q := Time{X: qx, Y: qy}
			if !since.Dominates(q) {
				continue
			}
			out, err := h.RegisterQuery(fmt.Sprintf("q-%d-%d", qx, qy), q)
			if err != nil {
				t.Fatal(err)
			}
			checkWeights(t, out.Delivered[0].Weights, expectedGridWeights(records, q))
		}
	}
}

func TestQueryBlockersExhaustiveSmallGrid(t *testing.T) {
	grid := make([]Time, 0, 9)
	for x := uint64(0); x <= 2; x++ {
		for y := uint64(0); y <= 2; y++ {
			grid = append(grid, Time{X: x, Y: y})
		}
	}

	for mask := 0; mask < 1<<len(grid); mask++ {
		raw := make([]Time, 0, len(grid))
		for i, p := range grid {
			if mask&(1<<i) != 0 {
				raw = append(raw, p)
			}
		}
		frontier := NewAntichain(raw...)
		h := newTestHost(t, 1)
		if _, err := h.AdvanceFrontier(0, raw); err != nil {
			t.Fatalf("mask %d: %v", mask, err)
		}
		for qx := uint64(0); qx <= 3; qx++ {
			for qy := uint64(0); qy <= 3; qy++ {
				q := Time{X: qx, Y: qy}
				id := fmt.Sprintf("%d", mask) + "-" + fmt.Sprint(q)
				out, err := h.RegisterQuery(id, q)
				if err != nil {
					t.Fatalf("mask %d q=%s: %v", mask, q, err)
				}

				var blocking []Time
				for _, p := range frontier.Points() {
					if p.LessOrEqual(q) {
						blocking = append(blocking, p)
					}
				}
				if len(blocking) == 0 {
					if len(out.Delivered) != 1 || out.Delivered[0].ID != id {
						t.Fatalf("mask %d q=%s should be complete: %+v", mask, q, out.Delivered)
					}
					if _, err := h.QueryStatus(id); !errors.Is(err, ErrUnknownQueryID) {
						t.Fatalf("mask %d q=%s complete query still live: %v", mask, q, err)
					}
					continue
				}
				if len(out.Delivered) != 0 {
					t.Fatalf("mask %d q=%s delivered early: %+v", mask, q, out.Delivered)
				}
				status, err := h.QueryStatus(id)
				if err != nil {
					t.Fatalf("mask %d q=%s: %v", mask, q, err)
				}
				if status.Complete || !status.Allowed {
					t.Fatalf("mask %d q=%s status = %+v", mask, q, status)
				}
				want := []Blocker{{Input: 0, Points: blocking}}
				if !reflect.DeepEqual(status.Blockers, want) {
					t.Fatalf("mask %d q=%s blockers = %+v, want %+v", mask, q, status.Blockers, want)
				}
			}
		}
	}
}

func newTestHost(t *testing.T, inputs int) *Host {
	t.Helper()
	h, err := NewHost(inputs)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func checkWeights(t *testing.T, got map[string]*big.Int, want map[string]int64) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("weights = %v, want %v", formatWeights(got), want)
	}
	for key, weight := range want {
		actual, ok := got[key]
		if !ok {
			t.Fatalf("missing key %q in %v", key, formatWeights(got))
		}
		if actual.Cmp(big.NewInt(weight)) != 0 {
			t.Fatalf("weight[%q] = %s, want %d", key, actual, weight)
		}
	}
	for key := range got {
		if _, ok := want[key]; !ok {
			t.Fatalf("unexpected key %q in %v", key, formatWeights(got))
		}
	}
}

func formatWeights(weights map[string]*big.Int) map[string]string {
	out := make(map[string]string, len(weights))
	for key, weight := range weights {
		out[key] = weight.String()
	}
	return out
}

func expectedGridWeights(records []gridRecord, q Time) map[string]int64 {
	sums := make(map[string]int64)
	for _, record := range records {
		if record.at.LessOrEqual(q) {
			sums[record.key] += record.weight
		}
	}
	for key, sum := range sums {
		if sum == 0 {
			delete(sums, key)
		}
	}
	return sums
}
