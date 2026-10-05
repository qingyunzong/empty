package merge

import (
	"testing"
)

func mustAdd(t *testing.T, m *Merger, names ...string) {
	t.Helper()
	for _, n := range names {
		if err := m.AddSource(n); err != nil {
			t.Fatalf("AddSource(%q): %v", n, err)
		}
	}
}

func mustEmit(t *testing.T, m *Merger, ev Event) {
	t.Helper()
	if err := m.Emit(ev); err != nil {
		t.Fatalf("Emit(%+v): %v", ev, err)
	}
}

func mustAdvance(t *testing.T, m *Merger, name string, wm int64) {
	t.Helper()
	if err := m.Advance(name, wm); err != nil {
		t.Fatalf("Advance(%q, %d): %v", name, wm, err)
	}
}

func publishedTS(m *Merger) []int64 {
	var out []int64
	for _, ev := range m.Published() {
		out = append(out, ev.TS)
	}
	return out
}

func equalInts(a, b []int64) bool {
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

// The safe prefix is bounded by the minimum watermark of non-idle
// sources: only events at or below that bound are published, in
// globally monotonic order.
func TestSafePrefixUsesMinActiveWatermark(t *testing.T) {
	m := NewMerger()
	mustAdd(t, m, "a", "b")

	mustEmit(t, m, Event{Source: "a", TS: 5, Payload: "a5"})
	mustEmit(t, m, Event{Source: "b", TS: 3, Payload: "b3"})
	mustEmit(t, m, Event{Source: "a", TS: 12, Payload: "a12"})

	mustAdvance(t, m, "a", 10)
	if got := publishedTS(m); len(got) != 0 {
		t.Fatalf("published before b advanced: %v", got)
	}

	mustAdvance(t, m, "b", 7)
	if got, want := publishedTS(m), []int64{3, 5}; !equalInts(got, want) {
		t.Fatalf("prefix = %v, want %v", got, want)
	}

	mustAdvance(t, m, "b", 20)
	// a's watermark (10) still bounds the prefix; advance it to release a12.
	mustAdvance(t, m, "a", 20)
	if got, want := publishedTS(m), []int64{3, 5, 12}; !equalInts(got, want) {
		t.Fatalf("prefix = %v, want %v", got, want)
	}
	if wm := m.PublishedWatermark(); wm != 12 {
		t.Fatalf("published watermark = %d, want 12", wm)
	}
}

// A source declared idle is excluded from the minimum-watermark
// computation and no longer blocks the safe prefix.
func TestIdleSourceDoesNotBlock(t *testing.T) {
	m := NewMerger()
	mustAdd(t, m, "fast", "stuck")

	mustEmit(t, m, Event{Source: "fast", TS: 1})
	mustEmit(t, m, Event{Source: "fast", TS: 2})
	mustEmit(t, m, Event{Source: "fast", TS: 3})
	mustAdvance(t, m, "fast", 3)
	if got := publishedTS(m); len(got) != 0 {
		t.Fatalf("stuck source should block prefix, got %v", got)
	}

	if err := m.DeclareIdle("stuck"); err != nil {
		t.Fatalf("DeclareIdle: %v", err)
	}
	if got, want := publishedTS(m), []int64{1, 2, 3}; !equalInts(got, want) {
		t.Fatalf("prefix after idle = %v, want %v", got, want)
	}
}

// A recovered source must not deliver events below the published
// watermark: they are quarantined and reported, never published.
func TestRecoveredSourceLateEventIsolated(t *testing.T) {
	m := NewMerger()
	mustAdd(t, m, "main", "flaky")

	mustEmit(t, m, Event{Source: "main", TS: 10})
	mustAdvance(t, m, "main", 10)
	if err := m.DeclareIdle("flaky"); err != nil {
		t.Fatalf("DeclareIdle: %v", err)
	}
	if got, want := publishedTS(m), []int64{10}; !equalInts(got, want) {
		t.Fatalf("prefix = %v, want %v", got, want)
	}

	if err := m.Recover("flaky"); err != nil {
		t.Fatalf("Recover: %v", err)
	}
	// Late event below the published watermark (10).
	mustEmit(t, m, Event{Source: "flaky", TS: 4, Payload: "late"})
	// On-time event from the recovered source.
	mustEmit(t, m, Event{Source: "flaky", TS: 11, Payload: "ok"})
	mustAdvance(t, m, "flaky", 11)
	mustAdvance(t, m, "main", 20)

	if got, want := publishedTS(m), []int64{10, 11}; !equalInts(got, want) {
		t.Fatalf("prefix = %v, want %v", got, want)
	}
	q := m.Quarantine()
	if len(q) != 1 || q[0].TS != 4 || q[0].Source != "flaky" {
		t.Fatalf("quarantine = %+v, want the late flaky event", q)
	}
	rep := m.IsolationReport()
	if len(rep) != 1 {
		t.Fatalf("isolation report len = %d, want 1", len(rep))
	}
	if rep[0].PublishedWatermark != 10 || rep[0].Reason == "" {
		t.Fatalf("isolation record = %+v", rep[0])
	}
}

// Virtual replay confirms the published prefix is globally monotonic
// and that quarantined events stayed outside the output (isolation
// scope intact).
func TestReplayVerifiesMonotonicityAndIsolation(t *testing.T) {
	m := NewMerger()
	mustAdd(t, m, "x", "y")

	mustEmit(t, m, Event{Source: "x", TS: 2})
	mustEmit(t, m, Event{Source: "y", TS: 1})
	mustEmit(t, m, Event{Source: "x", TS: 8})
	mustEmit(t, m, Event{Source: "y", TS: 9})
	mustAdvance(t, m, "x", 8)
	mustAdvance(t, m, "y", 9)

	// Force a late arrival into quarantine.
	mustEmit(t, m, Event{Source: "x", TS: 0, Payload: "too-late"})

	rep := m.Replay()
	if !rep.Monotonic {
		t.Fatalf("replay: monotonicity violated at TS %d", rep.FirstViolationTS)
	}
	if !rep.IsolationIntact {
		t.Fatalf("replay: quarantined events leaked: %+v", rep.LeakedEvents)
	}
	if rep.EventsReplayed != 4 {
		t.Fatalf("replay: events replayed = %d, want 4", rep.EventsReplayed)
	}
	if len(m.Quarantine()) != 1 {
		t.Fatalf("quarantine len = %d, want 1", len(m.Quarantine()))
	}
}

// Watermarks never move backward.
func TestWatermarkDoesNotRegress(t *testing.T) {
	m := NewMerger()
	mustAdd(t, m, "s")
	mustAdvance(t, m, "s", 10)
	mustAdvance(t, m, "s", 3)
	mustEmit(t, m, Event{Source: "s", TS: 7})
	if got := publishedTS(m); len(got) != 0 {
		t.Fatalf("regressed watermark published events: %v", got)
	}
	mustAdvance(t, m, "s", 8)
	if got, want := publishedTS(m), []int64{7}; !equalInts(got, want) {
		t.Fatalf("prefix = %v, want %v", got, want)
	}
}

// Unknown sources are rejected.
func TestUnknownSourceRejected(t *testing.T) {
	m := NewMerger()
	if err := m.Emit(Event{Source: "ghost", TS: 1}); err == nil {
		t.Fatal("Emit from unknown source: want error")
	}
	if err := m.Advance("ghost", 1); err == nil {
		t.Fatal("Advance of unknown source: want error")
	}
	if err := m.DeclareIdle("ghost"); err == nil {
		t.Fatal("DeclareIdle of unknown source: want error")
	}
}
