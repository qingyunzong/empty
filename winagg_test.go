package winagg

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func ingestAll(a *Aggregator, events []Event) []Result {
	res := make([]Result, len(events))
	for i, e := range events {
		res[i] = a.Ingest(e)
	}
	return res
}

func TestHalfOpenWindows(t *testing.T) {
	a := NewAggregator(10, 100) // generous lateness so all four events land
	ingestAll(a, []Event{
		{ID: "a", Time: 0, Value: 1},
		{ID: "b", Time: 9, Value: 2},
		{ID: "c", Time: 10, Value: 4}, // belongs to [10,20), not [0,10)
		{ID: "d", Time: -1, Value: 8}, // belongs to [-10,0)
	})
	got := a.Snapshot()
	want := []WindowStat{
		{Start: -10, End: 0, Sum: 8, Count: 1, Revision: 1},
		{Start: 0, End: 10, Sum: 3, Count: 2, Revision: 2},
		{Start: 10, End: 20, Sum: 4, Count: 1, Revision: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot mismatch\ngot:  %+v\nwant: %+v", got, want)
	}
}

func TestWatermarkNeverRetreats(t *testing.T) {
	a := NewAggregator(10, 100)
	var maxSeen int64
	for i, ts := range []int64{50, 30, 80, 10, 79, 5} {
		a.Ingest(Event{ID: fmt.Sprint(i), Time: ts, Value: 1})
		wm, _ := a.Watermark()
		if ts > maxSeen {
			maxSeen = ts
		}
		if wm != maxSeen {
			t.Fatalf("watermark retreated: got %d, want %d", wm, maxSeen)
		}
	}
}

func TestLatenessBoundary(t *testing.T) {
	a := NewAggregator(10, 5)
	a.Ingest(Event{ID: "first", Time: 100, Value: 1}) // watermark = 100

	if r := a.Ingest(Event{ID: "edge", Time: 95, Value: 1}); r != Applied {
		t.Fatalf("event at watermark-L must be accepted, got %v", r)
	}
	if r := a.Ingest(Event{ID: "late", Time: 94, Value: 1}); r != RejectedLate {
		t.Fatalf("event older than watermark-L must be rejected, got %v", r)
	}
	if a.Rejected() != 1 {
		t.Fatalf("rejected count = %d, want 1", a.Rejected())
	}
}

func TestCorrectionRevokesOldContribution(t *testing.T) {
	a := NewAggregator(10, 100)
	a.Ingest(Event{ID: "x", Kind: Add, Time: 3, Value: 10})
	a.Ingest(Event{ID: "y", Kind: Add, Time: 4, Value: 1})

	// Same-window correction: value replaced.
	if r := a.Ingest(Event{ID: "x", Kind: Correction, Time: 3, Value: 7}); r != Corrected {
		t.Fatalf("correction result = %v, want corrected", r)
	}
	// Cross-window correction: contribution moves to another window.
	if r := a.Ingest(Event{ID: "x", Kind: Correction, Time: 12, Value: 5}); r != Corrected {
		t.Fatalf("correction result = %v, want corrected", r)
	}

	got := a.Snapshot()
	want := []WindowStat{
		// x revoked twice (rev+apply, rev+apply-move), y applied once.
		{Start: 0, End: 10, Sum: 1, Count: 1, Revision: 5},
		{Start: 10, End: 20, Sum: 5, Count: 1, Revision: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot mismatch\ngot:  %+v\nwant: %+v", got, want)
	}
}

func TestCorrectionOfUnknownIDAppliesAsNew(t *testing.T) {
	a := NewAggregator(10, 0)
	if r := a.Ingest(Event{ID: "ghost", Kind: Correction, Time: 1, Value: 3}); r != Applied {
		t.Fatalf("correction of unknown ID = %v, want applied", r)
	}
}

func TestLateCorrectionRejectedKeepsOldContribution(t *testing.T) {
	a := NewAggregator(10, 5)
	a.Ingest(Event{ID: "x", Time: 3, Value: 10})
	a.Ingest(Event{ID: "drive", Time: 100, Value: 1}) // watermark = 100

	if r := a.Ingest(Event{ID: "x", Kind: Correction, Time: 3, Value: 99}); r != RejectedLate {
		t.Fatalf("late correction = %v, want rejected-late", r)
	}
	for _, ws := range a.Snapshot() {
		if ws.Start == 0 && (ws.Sum != 10 || ws.Count != 1) {
			t.Fatalf("old contribution must survive rejected correction: %+v", ws)
		}
	}
}

// fullRecompute replays the accepted prefix of the stream from scratch:
// last accepted event per ID wins, contributions are grouped by window.
// It also derives each window's revision as the number of mutations
// (one apply per accepted event, plus one revoke per superseded ID).
func fullRecompute(windowSize int64, accepted []Event) []WindowStat {
	a := NewAggregator(windowSize, 0)
	a.lateness = 1 << 60 // accept everything: input is already filtered
	ingestAll(a, accepted)
	return a.Snapshot()
}

func TestOutOfOrderVsFullRecompute(t *testing.T) {
	const windowSize, lateness = 10, 15
	for _, seed := range []int64{1, 7, 42, 2026} {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))

			// Generate adds and corrections over a bounded time range.
			var stream []Event
			ids := make([]string, 0, 64)
			for i := 0; i < 64; i++ {
				id := fmt.Sprintf("e%d", i)
				ids = append(ids, id)
				stream = append(stream, Event{ID: id, Kind: Add,
					Time: int64(rng.Intn(200)), Value: float64(rng.Intn(100))})
			}
			for i := 0; i < 48; i++ {
				stream = append(stream, Event{ID: ids[rng.Intn(len(ids))],
					Kind: Correction, Time: int64(rng.Intn(200)),
					Value: float64(rng.Intn(100))})
			}
			// Shuffle to force out-of-order arrival.
			rng.Shuffle(len(stream), func(i, j int) {
				stream[i], stream[j] = stream[j], stream[i]
			})

			a := NewAggregator(windowSize, lateness)
			results := ingestAll(a, stream)

			var accepted []Event
			for i, r := range results {
				if r != RejectedLate {
					accepted = append(accepted, stream[i])
				}
			}

			got := a.Snapshot()
			want := fullRecompute(windowSize, accepted)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("incremental != full recompute\ngot:  %+v\nwant: %+v", got, want)
			}
			if len(accepted)+a.Rejected() != len(stream) {
				t.Fatalf("accepted+rejected = %d, stream = %d",
					len(accepted)+a.Rejected(), len(stream))
			}
		})
	}
}
