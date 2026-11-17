package formal

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func foldRows(op *WindowOperator) []Row {
	return ViewRows(FoldChanges(op.Changes()))
}

func assertRows(t *testing.T, got, want []Row) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rows mismatch\ngot:  %+v\nwant: %+v", got, want)
	}
}

func TestWatermarkMonotonic(t *testing.T) {
	gen := NewWatermarkGenerator(5)
	checks := []struct {
		observe int64
		want    int64
	}{
		{10, 5},
		{8, 5}, // older event must not move watermark backwards
		{20, 15},
		{20, 15},
	}
	for _, check := range checks {
		if got := gen.Observe(check.observe); got != check.want {
			t.Fatalf("Observe(%d)=%d, want %d", check.observe, got, check.want)
		}
	}
	// Explicit backwards advance is ignored.
	if got := gen.Advance(3); got != 15 {
		t.Fatalf("backwards Advance returned %d, want 15", got)
	}
	if got := gen.Advance(50); got != 50 {
		t.Fatalf("Advance(50)=%d, want 50", got)
	}

	op := NewWindowOperator(NewTumblingAssigner(10), 0)
	op.advanceWatermark(100)
	op.advanceWatermark(99)
	op.advanceWatermark(100)
	if op.Watermark() != 100 {
		t.Fatalf("operator watermark = %d, want 100", op.Watermark())
	}
}

func TestTumblingRetractionAndLateness(t *testing.T) {
	op := NewWindowOperator(NewTumblingAssigner(10), 5)

	op.OnEvent(Event{ID: "a", Timestamp: 1, Value: 1})
	// Watermark 10 fires [0,10): row count=1 sum=1.
	op.advanceWatermark(10)
	assertRows(t, foldRows(op), []Row{{Window: Window{0, 10}, Count: 1, Sum: 1}})

	// In-arrival event at ts=7: horizon 7+5=12 >= wm 10 -> accepted, old row
	// retracted and corrected row emitted.
	op.OnEvent(Event{ID: "b", Timestamp: 7, Value: 2})
	assertRows(t, foldRows(op), []Row{{Window: Window{0, 10}, Count: 2, Sum: 3}})

	// ts=4 with wm=10: horizon 9 < 10 -> too late, dropped.
	op.advanceWatermark(10)
	op.OnEvent(Event{ID: "late", Timestamp: 4, Value: 99})
	if op.DroppedLateEvents() != 1 {
		t.Fatalf("dropped=%d, want 1", op.DroppedLateEvents())
	}
	assertRows(t, foldRows(op), []Row{{Window: Window{0, 10}, Count: 2, Sum: 3}})

	// Watermark past end+allowedLateness (10+5=15) purges state but keeps the
	// already-emitted row in the materialized view.
	op.advanceWatermark(16)
	if op.ActiveWindowCount() != 0 {
		t.Fatalf("active windows after cleanup: %d, want 0", op.ActiveWindowCount())
	}
	assertRows(t, foldRows(op), []Row{{Window: Window{0, 10}, Count: 2, Sum: 3}})

	var retractions int
	for _, change := range op.Changes() {
		if change.Kind == Retract {
			retractions++
		}
	}
	if retractions != 1 {
		t.Fatalf("retractions=%d, want 1", retractions)
	}
}

func TestSessionMergeAfterFire(t *testing.T) {
	// gap=10, allowedLateness=3: events at 0 and 15 are separate sessions; an
	// event at 9 bridges them (the early session remains in state past its
	// fire time because of the lateness horizon).
	op := NewWindowOperator(NewSessionAssigner(10), 3)

	op.OnEvent(Event{ID: "a", Timestamp: 0, Value: 1})  // [0,10)
	op.OnEvent(Event{ID: "b", Timestamp: 15, Value: 2}) // [15,25)
	op.advanceWatermark(10)                             // fires [0,10)
	assertRows(t, foldRows(op), []Row{
		{Window: Window{0, 10}, Count: 1, Sum: 1},
	})

	// Bridge event [9,19) overlaps both sessions -> merge into [0,25).
	op.OnEvent(Event{ID: "c", Timestamp: 9, Value: 4})

	// Old timers of both predecessor windows must be invalidated, and the
	// merged window owns fresh timers.
	for _, key := range []timerKey{
		{0, 10, fireTimer},
		{15, 25, fireTimer},
		{0, 10, cleanupTimer},
		{15, 25, cleanupTimer},
	} {
		if old, ok := op.timers.registry[key]; ok {
			t.Fatalf("stale timer %+v still registered (active=%v)", key, old.active)
		}
	}
	// The single merged window owns its fire and cleanup timers.
	if _, ok := op.timers.registry[timerKey{0, 25, fireTimer}]; !ok {
		t.Fatalf("merged fire timer missing")
	}
	if _, ok := op.timers.registry[timerKey{0, 25, cleanupTimer}]; !ok {
		t.Fatalf("merged cleanup timer missing")
	}
	if op.timers.activeCount() != 2 {
		t.Fatalf("active timers=%d, want 2 for the merged window", op.timers.activeCount())
	}

	// Stale row retracted, merged row emitted; state is conserved.
	assertRows(t, foldRows(op), []Row{
		{Window: Window{0, 25}, Count: 3, Sum: 7},
	})
	count, sum := op.StateTotals()
	if count != 3 || sum != 7 {
		t.Fatalf("state totals=(%d,%d), want (3,7)", count, sum)
	}

	// Firing the merged window produces no duplicate row.
	op.advanceWatermark(25)
	assertRows(t, foldRows(op), []Row{
		{Window: Window{0, 25}, Count: 3, Sum: 7},
	})
	// Cleanup horizon for the merged window is 25+3=28.
	op.advanceWatermark(29)
	if op.ActiveWindowCount() != 0 {
		t.Fatalf("active windows after cleanup: %d, want 0", op.ActiveWindowCount())
	}
	assertRows(t, foldRows(op), []Row{
		{Window: Window{0, 25}, Count: 3, Sum: 7},
	})
}

func TestLateEventAfterCleanupDropped(t *testing.T) {
	op := NewWindowOperator(NewTumblingAssigner(10), 2)
	op.OnEvent(Event{ID: "a", Timestamp: 1, Value: 1})
	op.advanceWatermark(20) // past cleanup horizon 10+2=12
	if op.ActiveWindowCount() != 0 {
		t.Fatalf("window not purged")
	}
	op.OnEvent(Event{ID: "late", Timestamp: 3, Value: 5})
	if op.DroppedLateEvents() != 1 {
		t.Fatalf("dropped=%d, want 1", op.DroppedLateEvents())
	}
	assertRows(t, foldRows(op), []Row{{Window: Window{0, 10}, Count: 1, Sum: 1}})
}

func TestNegativeTimestampTumbling(t *testing.T) {
	op := NewWindowOperator(NewTumblingAssigner(10), 0)
	op.OnEvent(Event{ID: "a", Timestamp: -3, Value: 1})
	op.OnEvent(Event{ID: "b", Timestamp: -10, Value: 2})
	op.OnEvent(Event{ID: "c", Timestamp: 0, Value: 3})
	op.advanceWatermark(10)
	assertRows(t, foldRows(op), []Row{
		{Window: Window{-10, 0}, Count: 2, Sum: 3},
		{Window: Window{0, 10}, Count: 1, Sum: 3},
	})
	oracleSignals := []Signal{
		{Event: Event{ID: "a", Timestamp: -3, Value: 1}},
		{Event: Event{ID: "b", Timestamp: -10, Value: 2}},
		{Event: Event{ID: "c", Timestamp: 0, Value: 3}},
		{IsWatermark: true, Watermark: 10},
	}
	assertRows(t, foldRows(op), NaiveOracle(oracleSignals, NewTumblingAssigner(10), 0))
}

func TestSnapshotRoundTrip(t *testing.T) {
	op := NewWindowOperator(NewSessionAssigner(10), 3)
	op.OnEvent(Event{ID: "a", Timestamp: 0, Value: 1})
	op.OnEvent(Event{ID: "b", Timestamp: 20, Value: 5})
	op.advanceWatermark(10)

	data, err := op.Snapshot()
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	restored, err := Restore(data)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}

	if restored.Watermark() != op.Watermark() ||
		restored.DroppedLateEvents() != op.DroppedLateEvents() ||
		restored.ActiveWindowCount() != op.ActiveWindowCount() ||
		restored.timers.activeCount() != op.timers.activeCount() {
		t.Fatalf("restored state diverged from source")
	}
	if !reflect.DeepEqual(restored.Changes(), op.Changes()) {
		t.Fatalf("restored changelog diverged")
	}

	tail := []Signal{
		{Event: Event{ID: "c", Timestamp: 9, Value: 2}},
		{IsWatermark: true, Watermark: 25},
		{Event: Event{ID: "late", Timestamp: 0, Value: 9}},
		{IsWatermark: true, Watermark: 100},
	}
	for _, signal := range tail {
		op.Process(signal)
		restored.Process(signal)
	}
	if !reflect.DeepEqual(restored.Changes(), op.Changes()) {
		t.Fatalf("post-restore changelogs diverge\na: %+v\nb: %+v",
			op.Changes(), restored.Changes())
	}
}

func TestRecoveryReplayMatchesNaive(t *testing.T) {
	signals := buildRandomSignals(rand.New(rand.NewSource(42)), 60)

	runWithCheckpoint := func(checkpoint int) *WindowOperator {
		op := NewWindowOperator(NewSessionAssigner(8), 4)
		for i, signal := range signals {
			if i == checkpoint {
				data, err := op.Snapshot()
				if err != nil {
					t.Fatalf("snapshot at %d: %v", checkpoint, err)
				}
				restored, err := Restore(data)
				if err != nil {
					t.Fatalf("restore at %d: %v", checkpoint, err)
				}
				op = restored
			}
			op.Process(signal)
		}
		return op
	}

	baseline := NewWindowOperator(NewSessionAssigner(8), 4)
	for _, signal := range signals {
		baseline.Process(signal)
	}

	for _, checkpoint := range []int{1, 7, 13, 25, 40, len(signals) - 1} {
		recovered := runWithCheckpoint(checkpoint)
		if !reflect.DeepEqual(recovered.Changes(), baseline.Changes()) {
			t.Fatalf("checkpoint %d: replay changelog diverged", checkpoint)
		}
		if !reflect.DeepEqual(foldRows(recovered), foldRows(baseline)) {
			t.Fatalf("checkpoint %d: replay view diverged", checkpoint)
		}
	}

	assertRows(t, foldRows(baseline), NaiveOracle(signals, NewSessionAssigner(8), 4))
}

func TestRandomizedMatchesNaiveTumbling(t *testing.T) {
	for _, seed := range []int64{1, 2, 3, 7, 11} {
		signals := buildRandomSignals(rand.New(rand.NewSource(seed)), 80)
		op := NewWindowOperator(NewTumblingAssigner(7), 5)
		var totalEvents int64
		for _, signal := range signals {
			op.Process(signal)
			if !signal.IsWatermark {
				totalEvents++
			}
			// Per-step invariant: every fired live window must equal the row
			// currently held in the folded materialized view.
			view := FoldChanges(op.Changes())
			for _, group := range op.windows {
				for _, state := range group {
					if !state.fired {
						continue
					}
					row, ok := view[state.window.Start][state.window.End]
					if !ok || row.Count != state.count || row.Sum != state.sum {
						t.Fatalf("seed %d: view row %+v != state %+v", seed, row, state)
					}
				}
			}
		}
		// Conservation: every accepted event appears in a live window or in an
		// emitted view row, never lost or double counted.
		var viewCount int64
		for _, row := range foldRows(op) {
			viewCount += row.Count
		}
		liveCount, _ := op.StateTotals()
		if viewCount+liveCount != totalEvents-op.DroppedLateEvents() {
			t.Fatalf("seed %d: conservation violated view=%d live=%d events=%d dropped=%d",
				seed, viewCount, liveCount, totalEvents, op.DroppedLateEvents())
		}

		assertRows(t, foldRows(op), NaiveOracle(signals, NewTumblingAssigner(7), 5))
	}
}

func TestRandomizedMatchesNaiveSession(t *testing.T) {
	for _, seed := range []int64{100, 200, 300} {
		signals := buildRandomSignals(rand.New(rand.NewSource(seed)), 100)
		op := NewWindowOperator(NewSessionAssigner(6), 3)
		for _, signal := range signals {
			op.Process(signal)
		}
		assertRows(t, foldRows(op), NaiveOracle(signals, NewSessionAssigner(6), 3))

		wm := MinTimestamp
		var accepted int64
		for _, signal := range signals {
			if signal.IsWatermark {
				if signal.Watermark > wm {
					wm = signal.Watermark
				}
				continue
			}
			if wm == MinTimestamp || signal.Event.Timestamp+3 >= wm {
				accepted++
			}
		}
		var viewCount int64
		for _, row := range foldRows(op) {
			viewCount += row.Count
		}
		liveCount, _ := op.StateTotals()
		if viewCount+liveCount != accepted {
			t.Fatalf("seed %d: session conservation violated %d+%d != %d",
				seed, viewCount, liveCount, accepted)
		}
	}
}

// buildRandomSignals creates an out-of-order mix of events and watermarks,
// ending with a watermark that closes every window and runs all cleanups.
func buildRandomSignals(rng *rand.Rand, n int) []Signal {
	signals := make([]Signal, 0, n+1)
	var maxTimestamp int64
	for i := 0; i < n; i++ {
		if rng.Intn(10) < 3 && maxTimestamp > 0 {
			signals = append(signals, Signal{
				IsWatermark: true,
				Watermark:   rng.Int63n(maxTimestamp + 1),
			})
			continue
		}
		base := rng.Int63n(120)
		jitter := int64(rng.Intn(15))
		ts := base - jitter
		if ts < 0 {
			ts = 0
		}
		if ts > maxTimestamp {
			maxTimestamp = ts
		}
		signals = append(signals, Signal{
			Event: Event{
				ID:        fmt.Sprintf("e-%d", len(signals)),
				Timestamp: ts,
				Value:     rng.Int63n(20) - 10,
			},
		})
	}
	// Large watermark so all fire and cleanup timers are due.
	signals = append(signals, Signal{IsWatermark: true, Watermark: 1 << 40})
	return signals
}
