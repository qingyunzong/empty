package dataeng

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
	"sync"
	"testing"
)

// Tie-breaking uses UTF-8 byte order of the observation ID.
func TestOrderingByTimeThenIDBytes(t *testing.T) {
	rec := newRecorder()
	c := NewCorrelator(rec.emit)

	type entry struct {
		id string
		t  int64
	}
	entries := []entry{
		{"b", 101}, {"a", 101}, {"\u00e9", 102}, {"A", 100},
		{"a\u00ff", 102}, {"aa", 100},
	}
	for _, e := range entries {
		must(t, c.AddObservation(obs(e.id, "d1", e.t, "x")))
	}
	must(t, c.AdvanceObservationWatermark(1000))
	must(t, c.AdvanceConfigWatermark(1000))

	got := resultIDs(rec.snapshot())
	want := append([]entry(nil), entries...)
	sort.SliceStable(want, func(i, j int) bool {
		if want[i].t != want[j].t {
			return want[i].t < want[j].t
		}
		return want[i].id < want[j].id // Go string comparison is byte order
	})
	wantIDs := make([]string, len(want))
	for i, e := range want {
		wantIDs[i] = e.id
	}
	if !reflect.DeepEqual(got, wantIDs) {
		t.Fatalf("order = %v, want %v", got, wantIDs)
	}
}

// A callback failure or unknown outcome retains the observation and stops the
// pump; Flush retries the same ID through the idempotent callback.
func TestEmitFailureAndRetry(t *testing.T) {
	rec := newRecorder()
	boom := errors.New("downstream unavailable")
	rec.failID = "o2"
	rec.err = boom
	c := NewCorrelator(rec.emit)

	must(t, c.AddConfig(cfg("d1", 0, 100, "cfg")))
	must(t, c.AddObservation(obs("o1", "d1", 1, "a")))
	must(t, c.AddObservation(obs("o2", "d1", 2, "b")))
	must(t, c.AddObservation(obs("o3", "d1", 3, "c")))

	must(t, c.AdvanceObservationWatermark(10))
	err := c.AdvanceConfigWatermark(10)
	if err == nil {
		t.Fatal("expected emit error, got nil")
	}
	var emitErr *EmitError
	if !errors.As(err, &emitErr) || emitErr.ObservationID != "o2" || !errors.Is(err, boom) {
		t.Fatalf("error = %v, want EmitError wrapping %q for o2", err, boom)
	}

	// o1 succeeded; o2 and everything after it are retained.
	if ids := resultIDs(rec.snapshot()); !reflect.DeepEqual(ids, []string{"o1"}) {
		t.Fatalf("successful results = %v, want [o1]", ids)
	}
	if c.Pending() != 2 {
		t.Fatalf("Pending = %d, want 2", c.Pending())
	}
	if rec.calls["o2"] != 1 {
		t.Fatalf("o2 callback calls = %d, want 1", rec.calls["o2"])
	}

	// Retry before the downstream recovers: same failure, same ID.
	if err := c.Flush(); !errors.As(err, &emitErr) || emitErr.ObservationID != "o2" {
		t.Fatalf("retry error = %v, want EmitError for o2", err)
	}
	if rec.calls["o2"] != 2 {
		t.Fatalf("o2 callback calls = %d, want 2", rec.calls["o2"])
	}

	// Recovery: the same observation ID is retried and the rest follow in order.
	rec.failID = ""
	must(t, c.Flush())
	if ids := resultIDs(rec.snapshot()); !reflect.DeepEqual(ids, []string{"o1", "o2", "o3"}) {
		t.Fatalf("results after recovery = %v, want [o1 o2 o3]", ids)
	}
	if c.Pending() != 0 {
		t.Fatalf("Pending = %d, want 0", c.Pending())
	}
	if rec.calls["o2"] != 3 {
		t.Fatalf("o2 callback calls = %d, want 3 (idempotent retries)", rec.calls["o2"])
	}

	// Nothing left to do.
	must(t, c.Flush())
}

// The component serializes concurrent ingestion; emitted output follows the
// deterministic ordering rules regardless of call scheduling.
func TestConcurrentIngestion(t *testing.T) {
	rec := newRecorder()
	c := NewCorrelator(rec.emit)

	const goroutines = 8
	const perG = 25
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < perG; i++ {
				id := fmt.Sprintf("g%02d-o%02d", g, i)
				if err := c.AddObservation(obs(id, "d1", int64(i), "p")); err != nil {
					t.Errorf("AddObservation(%s): %v", id, err)
					return
				}
			}
		}(g)
	}
	wg.Wait()

	if c.Pending() != goroutines*perG {
		t.Fatalf("Pending = %d, want %d", c.Pending(), goroutines*perG)
	}
	must(t, c.AdvanceObservationWatermark(int64(perG)+1))
	must(t, c.AdvanceConfigWatermark(int64(perG)+1))

	got := rec.snapshot()
	if len(got) != goroutines*perG {
		t.Fatalf("emitted %d results, want %d", len(got), goroutines*perG)
	}
	for i := 1; i < len(got); i++ {
		prev, cur := got[i-1].Observation, got[i].Observation
		if prev.EventTime > cur.EventTime ||
			(prev.EventTime == cur.EventTime && prev.ID >= cur.ID) {
			t.Fatalf("order violation at %d: %q before %q", i, prev.ID, cur.ID)
		}
	}
}

// Inputs and results carry independent byte slices: mutating caller-owned
// buffers after ingestion cannot corrupt component state or emitted results.
func TestPayloadDefensiveCopies(t *testing.T) {
	rec := newRecorder()
	c := NewCorrelator(rec.emit)

	o := obs("o1", "d1", 1, "original")
	in := cfg("d1", 0, 5, "config")
	must(t, c.AddConfig(in))
	must(t, c.AddObservation(o))

	o.Payload[0] = 'X'
	in.Payload[0] = 'X'
	must(t, c.AdvanceObservationWatermark(5))
	must(t, c.AdvanceConfigWatermark(5))

	got := rec.snapshot()
	if len(got) != 1 {
		t.Fatalf("results = %d, want 1", len(got))
	}
	if string(got[0].Observation.Payload) != "original" {
		t.Fatalf("observation payload mutated: %q", got[0].Observation.Payload)
	}
	if string(got[0].Config.Payload) != "config" {
		t.Fatalf("config payload mutated: %q", got[0].Config.Payload)
	}

	got[0].Observation.Payload[0] = 'Y'
	got[0].Config.Payload[0] = 'Y'
	must(t, c.Flush()) // retained state is empty, but stored data must stay intact
}
