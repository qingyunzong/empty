package streammerge

import (
	"fmt"
	"math/rand"
	"testing"
)

func tsOf(evs []Event) []int64 {
	out := make([]int64, len(evs))
	for i, ev := range evs {
		out[i] = ev.TS
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

// The safe prefix is everything at or below the minimum watermark of
// the non-idle sources, published in global timestamp order.
func TestSafePrefixIsMinOfNonIdleSources(t *testing.T) {
	m := New()
	m.AddSource("a")
	m.AddSource("b")
	m.AddSource("c")

	for _, ev := range []Event{
		{Source: "a", TS: 1}, {Source: "b", TS: 2}, {Source: "c", TS: 3},
		{Source: "a", TS: 4}, {Source: "b", TS: 5}, {Source: "c", TS: 6},
		{Source: "a", TS: 7},
	} {
		if err := m.Push(ev); err != nil {
			t.Fatal(err)
		}
	}
	mustAdvance(t, m, "a", 10)
	mustAdvance(t, m, "b", 8)
	mustAdvance(t, m, "c", 5) // min = 5

	if got, want := m.Watermark(), int64(5); got != want {
		t.Fatalf("watermark = %d, want %d", got, want)
	}
	if got, want := tsOf(m.Output()), []int64{1, 2, 3, 4, 5}; !equalInts(got, want) {
		t.Fatalf("output TS = %v, want %v", got, want)
	}
}

// An idle source stops blocking; the watermark jumps to the minimum of
// the remaining active sources and the safe prefix is flushed.
func TestIdleSourceDoesNotBlock(t *testing.T) {
	m := New()
	m.AddSource("fast")
	m.AddSource("slow")

	mustAdvance(t, m, "fast", 100)
	mustAdvance(t, m, "slow", 3)
	if err := m.Push(Event{Source: "fast", TS: 50}); err != nil {
		t.Fatal(err)
	}
	if got := len(m.Output()); got != 0 {
		t.Fatalf("output before idle = %d events, want 0 (slow source at 3)", got)
	}

	if err := m.SetIdle("slow", true); err != nil {
		t.Fatal(err)
	}
	if got, want := m.Watermark(), int64(100); got != want {
		t.Fatalf("watermark after idle = %d, want %d", got, want)
	}
	if got, want := tsOf(m.Output()), []int64{50}; !equalInts(got, want) {
		t.Fatalf("output after idle = %v, want %v", got, want)
	}
}

// A recovered source resumes at the published watermark. Events it
// replays at or below that watermark are isolated and reported, never
// published; events above it flow normally.
func TestRecoveredSourceLateEventsIsolated(t *testing.T) {
	m := New()
	m.AddSource("main")
	m.AddSource("flaky")

	if err := m.Push(Event{Source: "main", TS: 8, Payload: "published"}); err != nil {
		t.Fatal(err)
	}
	mustAdvance(t, m, "main", 10)
	mustAdvance(t, m, "flaky", 10)

	// flaky disconnects; main carries the watermark forward.
	if err := m.SetIdle("flaky", true); err != nil {
		t.Fatal(err)
	}
	if err := m.Push(Event{Source: "main", TS: 90}); err != nil {
		t.Fatal(err)
	}
	mustAdvance(t, m, "main", 100)

	// flaky recovers and replays a stale backlog.
	if err := m.SetIdle("flaky", false); err != nil {
		t.Fatal(err)
	}
	for _, ts := range []int64{50, 100} { // at or below published=100
		if err := m.Push(Event{Source: "flaky", TS: ts, Payload: "stale"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.Push(Event{Source: "flaky", TS: 150, Payload: "fresh"}); err != nil {
		t.Fatal(err)
	}
	mustAdvance(t, m, "main", 200)
	mustAdvance(t, m, "flaky", 200)

	iso := m.Isolated()
	if got, want := len(iso), 2; got != want {
		t.Fatalf("isolated count = %d, want %d", got, want)
	}
	for _, ie := range iso {
		if ie.Event.Payload != "stale" {
			t.Fatalf("isolated payload = %q, want %q", ie.Event.Payload, "stale")
		}
		if ie.Published != 100 {
			t.Fatalf("isolation recorded published=%d, want 100", ie.Published)
		}
		if ie.Reason == "" {
			t.Fatal("isolation report missing reason")
		}
	}
	for _, ev := range m.Output() {
		if ev.Payload == "stale" {
			t.Fatalf("stale event TS %d leaked into output", ev.TS)
		}
	}
	if got, want := tsOf(m.Output()), []int64{8, 90, 150}; !equalInts(got, want) {
		t.Fatalf("output TS = %v, want %v", got, want)
	}
}

// Per-source watermarks must be monotonic.
func TestWatermarkRegressionRejected(t *testing.T) {
	m := New()
	m.AddSource("a")
	mustAdvance(t, m, "a", 10)
	if err := m.Advance("a", 9); err == nil {
		t.Fatal("expected error for watermark regression")
	}
	if err := m.Advance("ghost", 1); err == nil {
		t.Fatal("expected error for unknown source")
	}
}

// Virtual replay: a deterministic, seeded simulation pushes events and
// advances watermarks across sources that randomly go idle and recover.
// After the replay, the output must be globally monotonic and the
// isolation scope exact: every isolated event was at or below the
// published watermark when diverted, and no event appears in both the
// output and the isolation report.
func TestVirtualReplayMonotonicAndIsolationScope(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	m := New()
	sources := []string{"s0", "s1", "s2", "s3"}
	for _, s := range sources {
		m.AddSource(s)
	}

	type key struct {
		src string
		seq int64
	}
	pushed := make(map[key]Event)
	seq := map[string]int64{}
	wm := map[string]int64{}

	for step := 0; step < 4000; step++ {
		src := sources[rng.Intn(len(sources))]
		switch rng.Intn(10) {
		case 0, 1: // toggle idle / recover
			st := m.sources[src]
			if err := m.SetIdle(src, !st.idle); err != nil {
				t.Fatal(err)
			}
			if st.idle { // just recovered: may replay stale events
				for i := 0; i < rng.Intn(3); i++ {
					staleTS := rng.Int63n(m.Watermark() + 2)
					seq[src]++
					ev := Event{Source: src, TS: staleTS, Seq: seq[src], Payload: "replay"}
					pushed[key{src, ev.Seq}] = ev
					if err := m.Push(ev); err != nil {
						t.Fatal(err)
					}
				}
			}
		case 2, 3, 4: // advance watermark
			// A recovered source resumes at the published watermark, so
			// the local tracker must catch up before moving forward.
			wm[src] = max(wm[src], m.Watermark()) + 1 + rng.Int63n(10)
			if err := m.Advance(src, wm[src]); err != nil {
				t.Fatal(err)
			}
		default: // push a fresh event near the source watermark
			seq[src]++
			ev := Event{Source: src, TS: wm[src] + rng.Int63n(20), Seq: seq[src], Payload: "live"}
			pushed[key{src, ev.Seq}] = ev
			if err := m.Push(ev); err != nil {
				t.Fatal(err)
			}
		}
	}

	// Flush: idle everything except one source and drive it to the max TS.
	var maxTS int64
	for _, ev := range pushed {
		if ev.TS > maxTS {
			maxTS = ev.TS
		}
	}
	for i, s := range sources {
		if i == 0 {
			if err := m.SetIdle(s, false); err != nil {
				t.Fatal(err)
			}
			mustAdvance(t, m, s, maxTS+1)
		} else {
			if err := m.SetIdle(s, true); err != nil {
				t.Fatal(err)
			}
		}
	}

	// 1. Global monotonicity of the published stream.
	out := m.Output()
	for i := 1; i < len(out); i++ {
		if out[i].TS < out[i-1].TS {
			t.Fatalf("output not monotonic at %d: TS %d after %d", i, out[i].TS, out[i-1].TS)
		}
		if out[i].TS > m.Watermark() {
			t.Fatalf("output event TS %d exceeds published watermark %d", out[i].TS, m.Watermark())
		}
	}

	// 2. Isolation scope: each isolated event was late w.r.t. the
	//    published watermark recorded at diversion time.
	for _, ie := range m.Isolated() {
		if ie.Event.TS > ie.Published {
			t.Fatalf("isolated event TS %d above published %d at isolation", ie.Event.TS, ie.Published)
		}
	}

	// 3. Output and isolation are disjoint, and every pushed event is
	//    accounted for in exactly one of them.
	seen := make(map[key]string, len(pushed))
	for _, ev := range out {
		k := key{ev.Source, ev.Seq}
		if _, ok := pushed[k]; !ok {
			t.Fatalf("output contains unknown event %+v", ev)
		}
		if where, dup := seen[k]; dup {
			t.Fatalf("event %+v in both %s and output", ev, where)
		}
		seen[k] = "output"
	}
	for _, ie := range m.Isolated() {
		k := key{ie.Event.Source, ie.Event.Seq}
		if _, ok := pushed[k]; !ok {
			t.Fatalf("isolation contains unknown event %+v", ie.Event)
		}
		if where, dup := seen[k]; dup {
			t.Fatalf("event %+v in both %s and isolation", ie.Event, where)
		}
		seen[k] = "isolation"
	}
	for k, ev := range pushed {
		if _, ok := seen[k]; !ok {
			t.Fatalf("pushed event %+v vanished (not in output or isolation)", ev)
		}
	}

	t.Logf("replayed %d events: %d published, %d isolated, final watermark %d",
		len(pushed), len(out), len(m.Isolated()), m.Watermark())
}

func mustAdvance(t *testing.T, m *Merger, id string, wm int64) {
	t.Helper()
	if err := m.Advance(id, wm); err != nil {
		t.Fatalf("Advance(%q, %d): %v", id, wm, err)
	}
}

func Example() {
	m := New()
	m.AddSource("kafka-0")
	m.AddSource("kafka-1")
	m.Push(Event{Source: "kafka-0", TS: 12, Payload: "a"})
	m.Push(Event{Source: "kafka-1", TS: 7, Payload: "b"})
	m.Advance("kafka-0", 20)
	m.Advance("kafka-1", 15)
	for _, ev := range m.Output() {
		fmt.Println(ev.TS, ev.Payload)
	}
	// Output:
	// 7 b
	// 12 a
}
