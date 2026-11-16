package session_test

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"

	"example.org/dataeng/q0250/session"
)

type sumAgg struct{}

func (sumAgg) New() int           { return 0 }
func (sumAgg) Add(acc, v int) int { return acc + v }
func (sumAgg) Merge(a, b int) int { return a + b }

func newStore(gap, lateness int64) *session.Store[string, int, int] {
	return session.New[string](gap, lateness, sumAgg{})
}

func TestBridgingEventMergesWindowsIntoCanonicalID(t *testing.T) {
	s := newStore(10, 100)

	ch, dropped := s.OnEvent("k", 0, 1)
	if dropped || len(ch) != 1 || ch[0].Kind != session.Add {
		t.Fatalf("first event: got %v dropped=%v", ch, dropped)
	}
	id1 := ch[0].Window.ID

	ch, _ = s.OnEvent("k", 20, 2)
	id2 := ch[0].Window.ID
	if id2 == id1 {
		t.Fatalf("disjoint windows must get distinct ids, both %d", id1)
	}

	// Move the second window next to the first without merging them yet.
	ch, _ = s.OnEvent("k", 12, 3)
	want := []session.Change[string, int]{
		{Seq: 3, Kind: session.Retract, Key: "k", Window: session.Window{ID: id2, Start: 20, End: 30}, Value: 2},
		{Seq: 4, Kind: session.Add, Key: "k", Window: session.Window{ID: id2, Start: 12, End: 30}, Value: 5},
	}
	if !reflect.DeepEqual(ch, want) {
		t.Fatalf("grow: got %+v want %+v", ch, want)
	}

	// This event bridges both windows; the smaller id survives.
	ch, _ = s.OnEvent("k", 5, 4)
	canonical := min(id1, id2)
	merged := max(id1, id2)
	want = []session.Change[string, int]{
		{Seq: 5, Kind: session.Retract, Key: "k", Window: session.Window{ID: merged, Start: 12, End: 30}, Value: 5},
		{Seq: 6, Kind: session.Retract, Key: "k", Window: session.Window{ID: canonical, Start: 0, End: 10}, Value: 1},
		{Seq: 7, Kind: session.Add, Key: "k", Window: session.Window{ID: canonical, Start: 0, End: 30}, Value: 10},
	}
	if !reflect.DeepEqual(ch, want) {
		t.Fatalf("bridge: got %+v want %+v", ch, want)
	}

	got := s.ActiveWindows("k")
	if len(got) != 1 || got[0] != (session.Window{ID: canonical, Start: 0, End: 30}) {
		t.Fatalf("active windows: got %+v", got)
	}
}

func TestLateEventRetractsEmittedResult(t *testing.T) {
	s := newStore(10, 50)

	ch, _ := s.OnEvent("k", 0, 1)
	id := ch[0].Window.ID
	s.OnWatermark(10) // window end passed, but lateness keeps state alive

	ch, dropped := s.OnEvent("k", 5, 2)
	if dropped {
		t.Fatal("late event within allowed lateness must not be dropped")
	}
	want := []session.Change[string, int]{
		{Seq: 2, Kind: session.Retract, Key: "k", Window: session.Window{ID: id, Start: 0, End: 10}, Value: 1},
		{Seq: 3, Kind: session.Add, Key: "k", Window: session.Window{ID: id, Start: 0, End: 15}, Value: 3},
	}
	if !reflect.DeepEqual(ch, want) {
		t.Fatalf("got %+v want %+v", ch, want)
	}
}

func TestAdjacentWindowsDoNotMerge(t *testing.T) {
	s := newStore(10, 0)
	s.OnEvent("k", 0, 1)
	s.OnEvent("k", 10, 1) // gap of exactly 10: new session
	s.OnEvent("k", -10, 1)
	if got := s.ActiveWindowCount(); got != 3 {
		t.Fatalf("got %d active windows, want 3", got)
	}
}

func TestWatermarkReclaimsStateAndDropsTooLateEvents(t *testing.T) {
	s := newStore(10, 5)
	ch, _ := s.OnEvent("k", 0, 1)
	win := ch[0].Window

	if got := s.OnWatermark(14); len(got) != 0 {
		t.Fatalf("wm=14 must not reclaim window ending at 10 with lateness 5: %v", got)
	}
	got := s.OnWatermark(15)
	if len(got) != 1 || got[0] != win {
		t.Fatalf("reclaimed: got %v want [%v]", got, win)
	}
	if n := s.ActiveWindowCount(); n != 0 {
		t.Fatalf("state not reclaimed, %d windows left", n)
	}

	changes, dropped := s.OnEvent("k", 1, 9)
	if !dropped || len(changes) != 0 {
		t.Fatalf("event past reclamation must be dropped: %v dropped=%v", changes, dropped)
	}
	if s.DroppedEvents() != 1 {
		t.Fatalf("dropped count = %d, want 1", s.DroppedEvents())
	}

	// The store still accepts fresh events after reclamation.
	if _, dropped := s.OnEvent("k", 100, 1); dropped {
		t.Fatal("fresh event must not be dropped")
	}
}

func TestRegressiveWatermarkDoesNotMoveClock(t *testing.T) {
	s := newStore(10, 0)
	s.OnEvent("k", 0, 1)
	s.OnWatermark(20)
	if got := s.OnWatermark(5); len(got) != 0 {
		t.Fatalf("regressive watermark reclaimed windows: %v", got)
	}
	if wm, ok := s.Watermark(); !ok || wm != 20 {
		t.Fatalf("watermark = %d,%v want 20,true", wm, ok)
	}
}

// scriptStep is one replayable input: an event or a watermark.
type scriptStep struct {
	wm    bool
	key   string
	ts    int64
	value int
}

func makeScript(seed int64, steps int) []scriptStep {
	r := rand.New(rand.NewSource(seed))
	keys := []string{"a", "b", "c", "d", "e"}
	var script []scriptStep
	clock := int64(0)
	wm := int64(-1000)
	for len(script) < steps {
		clock += 1 + r.Int63n(20)
		ts := clock
		if r.Intn(4) == 0 {
			ts -= r.Int63n(60) // late or out-of-order event
		}
		script = append(script, scriptStep{
			key:   keys[r.Intn(len(keys))],
			ts:    ts,
			value: 1 + r.Intn(9),
		})
		if r.Intn(5) == 0 {
			wm += r.Int63n(40)
			script = append(script, scriptStep{wm: true, ts: wm})
		}
	}
	return script
}

func runScript(script []scriptStep) ([]session.Change[string, int], [][]session.Window) {
	s := newStore(10, 30)
	var changes []session.Change[string, int]
	var reclaimed [][]session.Window
	for _, st := range script {
		if st.wm {
			reclaimed = append(reclaimed, s.OnWatermark(st.ts))
			continue
		}
		ch, _ := s.OnEvent(st.key, st.ts, st.value)
		changes = append(changes, ch...)
	}
	return changes, reclaimed
}

func TestReplayYieldsIdenticalChangeSequence(t *testing.T) {
	for _, seed := range []int64{1, 7, 42, 2026} {
		script := makeScript(seed, 2000)
		changes1, reclaimed1 := runScript(script)
		changes2, reclaimed2 := runScript(script)
		if !reflect.DeepEqual(changes1, changes2) {
			t.Fatalf("seed %d: replay diverged in changes", seed)
		}
		if !reflect.DeepEqual(reclaimed1, reclaimed2) {
			t.Fatalf("seed %d: replay diverged in reclamation", seed)
		}
		checkChangelogInvariants(t, changes1)
	}
}

// checkChangelogInvariants verifies the retract/add contract: sequence
// numbers increase, and every retract withdraws exactly the last unretracted
// add of the same key and window id.
func checkChangelogInvariants(t *testing.T, changes []session.Change[string, int]) {
	t.Helper()
	type emitted struct {
		key string
		id  session.ID
	}
	live := map[emitted]session.Change[string, int]{}
	var prevSeq int64
	for _, ch := range changes {
		if ch.Seq <= prevSeq {
			t.Fatalf("seq not increasing: %d after %d", ch.Seq, prevSeq)
		}
		prevSeq = ch.Seq
		k := emitted{ch.Key, ch.Window.ID}
		switch ch.Kind {
		case session.Add:
			live[k] = ch
		case session.Retract:
			last, ok := live[k]
			if !ok {
				t.Fatalf("retract without matching add: %+v", ch)
			}
			if last.Window != ch.Window || last.Value != ch.Value {
				t.Fatalf("retract %+v does not match last add %+v", ch, last)
			}
			delete(live, k)
		default:
			t.Fatalf("unknown change kind %v", ch.Kind)
		}
	}
}

func TestNonCommutativeAggregatorMergesDeterministically(t *testing.T) {
	// Concatenation is order-sensitive; merge order must follow window order.
	s := session.New[string](10, 0, concatAgg{})
	s.OnEvent("k", 0, "a")
	s.OnEvent("k", 18, "c")
	ch, _ := s.OnEvent("k", 9, "x") // candidate [9,19) bridges both windows
	last := ch[len(ch)-1]
	if last.Kind != session.Add || last.Value != "acx" {
		t.Fatalf("merged value = %q, want %q", last.Value, "acx")
	}
}

type concatAgg struct{}

func (concatAgg) New() string              { return "" }
func (concatAgg) Add(acc, v string) string { return acc + v }
func (concatAgg) Merge(a, b string) string { return a + b }

func ExampleStore() {
	s := session.New[string](10, 5, sumAgg{})
	changes, _ := s.OnEvent("user", 0, 1)
	fmt.Println(changes[0].Kind, changes[0].Window, changes[0].Value)
	changes, _ = s.OnEvent("user", 5, 2)
	for _, c := range changes {
		fmt.Println(c.Kind, c.Window, c.Value)
	}
	// Output:
	// add {1 0 10} 1
	// retract {1 0 10} 1
	// add {1 0 15} 3
}
