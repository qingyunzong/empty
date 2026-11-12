package dataeng

import (
	"errors"
	"reflect"
	"sync"
	"testing"
)

func obs(id, device string, t int64, payload string) Observation {
	return Observation{ID: id, DeviceID: device, EventTime: t, Payload: []byte(payload)}
}

func cfg(device string, start, end int64, payload string) ConfigInterval {
	return ConfigInterval{DeviceID: device, Start: start, End: end, Payload: []byte(payload)}
}

type recorder struct {
	mu      sync.Mutex
	results []Result
	failID  string
	calls   map[string]int
	err     error
}

func newRecorder() *recorder {
	return &recorder{calls: make(map[string]int)}
}

func (r *recorder) emit(res Result) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls[res.Observation.ID]++
	if r.failID == res.Observation.ID {
		return r.err
	}
	r.results = append(r.results, res)
	return nil
}

func (r *recorder) snapshot() []Result {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Result, len(r.results))
	copy(out, r.results)
	return out
}

func resultIDs(rs []Result) []string {
	ids := make([]string, len(rs))
	for i, r := range rs {
		ids[i] = r.Observation.ID
	}
	return ids
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// Half-open windows: touching intervals are legal, the end instant is
// excluded, and an observation with no covering window is unmatched.
func TestBoundaryTouchingAndHalfOpen(t *testing.T) {
	rec := newRecorder()
	c := NewCorrelator(rec.emit)

	must(t, c.AddConfig(cfg("d1", 0, 5, "early")))
	must(t, c.AddConfig(cfg("d1", 5, 10, "late"))) // touches previous window

	must(t, c.AddObservation(obs("o1", "d1", 4, "a")))
	must(t, c.AddObservation(obs("o2", "d1", 5, "b"))) // boundary: belongs to [5,10)
	must(t, c.AddObservation(obs("o3", "d1", 9, "c")))
	must(t, c.AddObservation(obs("o4", "d1", 10, "d"))) // outside every window
	must(t, c.AddObservation(obs("o5", "d2", 1, "e")))  // device without config

	must(t, c.AdvanceObservationWatermark(11))
	if got := rec.snapshot(); len(got) != 0 {
		t.Fatalf("nothing may be emitted before config watermark is set, got %v", resultIDs(got))
	}
	must(t, c.AdvanceConfigWatermark(11))

	got := rec.snapshot()
	wantIDs := []string{"o5", "o1", "o2", "o3", "o4"} // t=1,4,5,9,10
	if !reflect.DeepEqual(resultIDs(got), wantIDs) {
		t.Fatalf("emit order = %v, want %v", resultIDs(got), wantIDs)
	}

	checks := map[string]struct {
		matched bool
		payload string
	}{
		"o1": {true, "early"},
		"o2": {true, "late"},
		"o3": {true, "late"},
		"o4": {false, ""},
		"o5": {false, ""},
	}
	for _, r := range got {
		want := checks[r.Observation.ID]
		if r.Matched != want.matched {
			t.Errorf("%s: Matched = %v, want %v", r.Observation.ID, r.Matched, want.matched)
		}
		if want.matched && string(r.Config.Payload) != want.payload {
			t.Errorf("%s: config payload = %q, want %q", r.Observation.ID, r.Config.Payload, want.payload)
		}
		if !want.matched && r.Config != nil {
			t.Errorf("%s: expected nil config, got %+v", r.Observation.ID, r.Config)
		}
	}
}

// Configuration may arrive out of order and late, up until the configuration
// watermark passes the interval start.
func TestLateConfig(t *testing.T) {
	t.Run("rejected at or past watermark", func(t *testing.T) {
		rec := newRecorder()
		c := NewCorrelator(rec.emit)

		must(t, c.AddObservation(obs("o1", "d1", 3, "x")))
		must(t, c.AdvanceObservationWatermark(10))
		must(t, c.AdvanceConfigWatermark(3)) // W == t: strict rule keeps o1 pending

		// Interval starts at 0 < watermark 4: rejected, state unchanged.
		if err := c.AddConfig(cfg("d1", 0, 5, "late")); !errors.Is(err, ErrWatermark) {
			t.Fatalf("late interval error = %v, want ErrWatermark", err)
		}
		// Interval starting at the watermark is still legal (promise covers < W).
		must(t, c.AddConfig(cfg("d1", 3, 8, "at-watermark")))
		if c.Pending() != 1 {
			t.Fatalf("Pending = %d, want 1", c.Pending())
		}

		must(t, c.AdvanceConfigWatermark(4))
		got := rec.snapshot()
		if len(got) != 1 || !got[0].Matched ||
			got[0].Config == nil || string(got[0].Config.Payload) != "at-watermark" {
			t.Fatalf("observation should match the interval delivered at the watermark, got %+v", got)
		}
	})

	t.Run("out of order intervals", func(t *testing.T) {
		rec := newRecorder()
		c := NewCorrelator(rec.emit)

		must(t, c.AddConfig(cfg("d1", 10, 20, "c")))
		must(t, c.AddConfig(cfg("d1", 0, 5, "a")))
		must(t, c.AddConfig(cfg("d1", 5, 10, "b")))
		must(t, c.AddObservation(obs("o1", "d1", 7, "x")))
		must(t, c.AdvanceObservationWatermark(20))
		must(t, c.AdvanceConfigWatermark(20))

		got := rec.snapshot()
		if len(got) != 1 || !got[0].Matched || string(got[0].Config.Payload) != "b" {
			t.Fatalf("out-of-order config not correlated correctly: %+v", got)
		}
	})
}

// Re-delivery with identical content is ignored; conflicting content and
// overlapping windows are rejected without changing state.
func TestDuplicateAndConflict(t *testing.T) {
	t.Run("observations", func(t *testing.T) {
		rec := newRecorder()
		c := NewCorrelator(rec.emit)

		must(t, c.AddObservation(obs("o1", "d1", 3, "p")))
		must(t, c.AddObservation(obs("o1", "d1", 3, "p"))) // identical re-delivery

		if err := c.AddObservation(obs("o1", "d1", 3, "different")); !errors.Is(err, ErrDuplicateID) {
			t.Fatalf("conflict error = %v, want ErrDuplicateID", err)
		}
		if err := c.AddObservation(obs("o1", "d1", 4, "p")); !errors.Is(err, ErrDuplicateID) {
			t.Fatalf("conflict error = %v, want ErrDuplicateID", err)
		}
		if c.Pending() != 1 {
			t.Fatalf("Pending = %d, want 1 after rejected conflicts", c.Pending())
		}

		// Duplicate detection precedes the watermark check: a re-delivered
		// observation stays ignored even behind the watermark.
		must(t, c.AdvanceObservationWatermark(10))
		must(t, c.AdvanceConfigWatermark(10))
		must(t, c.AddObservation(obs("o1", "d1", 3, "p")))
		if err := c.AddObservation(obs("o1", "d1", 3, "different")); !errors.Is(err, ErrDuplicateID) {
			t.Fatalf("post-watermark conflict error = %v, want ErrDuplicateID", err)
		}
		if ids := resultIDs(rec.snapshot()); len(ids) != 1 || ids[0] != "o1" {
			t.Fatalf("exactly one emission expected, got %v", ids)
		}

		// Fresh observation behind the watermark is rejected.
		if err := c.AddObservation(obs("o2", "d1", 2, "p")); !errors.Is(err, ErrWatermark) {
			t.Fatalf("late observation error = %v, want ErrWatermark", err)
		}
	})

	t.Run("configs", func(t *testing.T) {
		rec := newRecorder()
		c := NewCorrelator(rec.emit)

		must(t, c.AddConfig(cfg("d1", 0, 5, "a")))
		must(t, c.AddConfig(cfg("d1", 0, 5, "a"))) // identical re-delivery

		cases := []ConfigInterval{
			cfg("d1", 4, 6, "overlap"),   // overlaps right edge
			cfg("d1", 0, 5, "revised"),   // same bounds, new content
			cfg("d1", -2, 1, "overlap2"), // overlaps left edge
			cfg("d2", 0, 0, "empty"),     // malformed
			cfg("d2", 5, 4, "reversed"),  // malformed
		}
		for i, in := range cases {
			want := ErrOverlap
			if in.End <= in.Start {
				want = ErrInvalidInterval
			}
			if err := c.AddConfig(in); !errors.Is(err, want) {
				t.Fatalf("case %d: error = %v, want %v", i, err, want)
			}
		}

		must(t, c.AdvanceConfigWatermark(5))
		must(t, c.AddConfig(cfg("d1", 0, 5, "a"))) // re-delivery still idempotent
		if err := c.AddConfig(cfg("d1", 2, 3, "late")); !errors.Is(err, ErrOverlap) {
			t.Fatalf("overlapping late interval error = %v, want ErrOverlap", err)
		}
		if err := c.AddConfig(cfg("d3", 2, 3, "late")); !errors.Is(err, ErrWatermark) {
			t.Fatalf("late interval error = %v, want ErrWatermark", err)
		}
		must(t, c.AddConfig(cfg("d3", 5, 6, "at-watermark"))) // start == W is legal

		if err := c.AdvanceConfigWatermark(4); !errors.Is(err, ErrWatermark) {
			t.Fatalf("regression error = %v, want ErrWatermark", err)
		}
	})
}

// Emission requires both watermarks to be strictly greater than the event
// time; the effective threshold is the smaller watermark.
func TestDualWatermarkInterleaving(t *testing.T) {
	rec := newRecorder()
	c := NewCorrelator(rec.emit)

	must(t, c.AddConfig(cfg("d1", 0, 100, "cfg")))
	must(t, c.AddObservation(obs("o1", "d1", 5, "a")))
	must(t, c.AddObservation(obs("o2", "d1", 10, "b")))
	must(t, c.AddObservation(obs("o3", "d1", 15, "c")))

	must(t, c.AdvanceObservationWatermark(10))
	if got := rec.snapshot(); len(got) != 0 {
		t.Fatalf("config watermark still -inf, got emissions %v", resultIDs(got))
	}

	must(t, c.AdvanceConfigWatermark(10)) // threshold 10: o1 (5) emits, o2 (10) held by strict >
	if ids := resultIDs(rec.snapshot()); !reflect.DeepEqual(ids, []string{"o1"}) {
		t.Fatalf("threshold 10 should release only t<10, got %v", ids)
	}

	must(t, c.AdvanceConfigWatermark(10)) // equal value is a no-op
	if ids := resultIDs(rec.snapshot()); !reflect.DeepEqual(ids, []string{"o1"}) {
		t.Fatalf("equal watermark must stay a no-op, got %v", ids)
	}

	must(t, c.AdvanceObservationWatermark(11)) // min(11,10)=10: o2 still held
	if ids := resultIDs(rec.snapshot()); !reflect.DeepEqual(ids, []string{"o1"}) {
		t.Fatalf("effective threshold 10 must keep t=10 pending, got %v", ids)
	}

	must(t, c.AdvanceConfigWatermark(11)) // threshold 11: o2 (10) now emits
	if ids := resultIDs(rec.snapshot()); !reflect.DeepEqual(ids, []string{"o1", "o2"}) {
		t.Fatalf("threshold 11 should release t<11, got %v", ids)
	}

	must(t, c.AdvanceConfigWatermark(20)) // OW still 11: o3 (15) held
	if ids := resultIDs(rec.snapshot()); !reflect.DeepEqual(ids, []string{"o1", "o2"}) {
		t.Fatalf("o3 still above observation watermark, got %v", ids)
	}

	must(t, c.AdvanceObservationWatermark(20))
	if ids := resultIDs(rec.snapshot()); !reflect.DeepEqual(ids, []string{"o1", "o2", "o3"}) {
		t.Fatalf("after both watermarks pass, got %v", ids)
	}
	if c.Pending() != 0 {
		t.Fatalf("Pending = %d, want 0", c.Pending())
	}

	// Watermarks are monotonic.
	if err := c.AdvanceObservationWatermark(19); !errors.Is(err, ErrWatermark) {
		t.Fatalf("watermark regression error = %v, want ErrWatermark", err)
	}
	if err := c.AdvanceConfigWatermark(1); !errors.Is(err, ErrWatermark) {
		t.Fatalf("watermark regression error = %v, want ErrWatermark", err)
	}
}
