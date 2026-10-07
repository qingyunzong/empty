package crashreplay_test

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"

	"crashreplay"
)

func writes(seq int, n int) []crashreplay.Event {
	var events []crashreplay.Event
	for i := 0; i < n; i++ {
		events = append(events, crashreplay.Event{
			Seq:   seq + i,
			Op:    crashreplay.OpWrite,
			Key:   fmt.Sprintf("k%d", i),
			Value: fmt.Sprintf("v%d", i),
		})
	}
	return events
}

func passInvariant(map[string]string) string { return "" }

// Acceptance: events deliberately published out of order must be accepted
// and produce exactly the same report as the ordered stream.
func TestOutOfOrderPublishAccepted(t *testing.T) {
	var events []crashreplay.Event
	events = append(events, writes(1, 6)...)
	events = append(events, crashreplay.Event{Seq: 7, Op: crashreplay.OpSync})
	events = append(events, writes(8, 5)...)
	events = append(events, crashreplay.Event{Seq: 13, Op: crashreplay.OpCrash})
	events = append(events, crashreplay.Event{Seq: 14, Op: crashreplay.OpWrite, Key: "k9", Value: "v9"})
	events = append(events, crashreplay.Event{Seq: 15, Op: crashreplay.OpSync})
	events = append(events, crashreplay.Event{Seq: 16, Op: crashreplay.OpCrash})

	inv := crashreplay.Require(map[string]string{"k0": "v0", "k5": "v5"})
	checker := crashreplay.Checker{Seed: 42, Shuffle: true}

	want, err := checker.Check(events, inv)
	if err != nil {
		t.Fatal(err)
	}
	if want.Verdict != crashreplay.VerdictOK {
		t.Fatalf("ordered run: got %s, want ok (%+v)", want.Verdict, want)
	}

	for trial := 0; trial < 10; trial++ {
		shuffled := append([]crashreplay.Event(nil), events...)
		rand.New(rand.NewSource(int64(trial))).Shuffle(len(shuffled), func(i, j int) {
			shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
		})
		got, err := checker.Check(shuffled, inv)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("trial %d: out-of-order report differs\n got %+v\nwant %+v", trial, got, want)
		}
	}
}

// Every persistent subset of the unsynced writes is enumerated.
func TestEnumerateAllPersistentSubsets(t *testing.T) {
	events := append(writes(1, 3), crashreplay.Event{Seq: 4, Op: crashreplay.OpCrash})

	seen := map[string]int{}
	collector := func(state map[string]string) string {
		seen[fmt.Sprint(state)]++
		return ""
	}
	report, err := crashreplay.Checker{Seed: 1}.Check(events, collector)
	if err != nil {
		t.Fatal(err)
	}
	if report.Verdict != crashreplay.VerdictOK {
		t.Fatalf("got %s, want ok", report.Verdict)
	}
	if report.Explored != 8 {
		t.Fatalf("explored %d states, want 2^3 = 8", report.Explored)
	}
	want := map[string]bool{
		"map[]": false, "map[k0:v0]": false, "map[k1:v1]": false, "map[k2:v2]": false,
		"map[k0:v0 k1:v1]": false, "map[k0:v0 k2:v2]": false, "map[k1:v1 k2:v2]": false,
		"map[k0:v0 k1:v1 k2:v2]": false,
	}
	for state := range seen {
		if _, ok := want[state]; !ok {
			t.Fatalf("unexpected state %s", state)
		}
		want[state] = true
	}
	for state, visited := range want {
		if !visited {
			t.Fatalf("state %s never enumerated", state)
		}
	}
}

// Overwritten keys: keeping an earlier write while dropping a later one is
// legal, so {a:1} and {a:2} are both reachable but never co-present.
func TestOverwriteSubsetSemantics(t *testing.T) {
	events := []crashreplay.Event{
		{Seq: 1, Op: crashreplay.OpWrite, Key: "a", Value: "1"},
		{Seq: 2, Op: crashreplay.OpWrite, Key: "a", Value: "2"},
		{Seq: 3, Op: crashreplay.OpCrash},
	}
	seen := map[string]bool{}
	collector := func(state map[string]string) string {
		seen[fmt.Sprint(state)] = true
		return ""
	}
	if _, err := (crashreplay.Checker{Seed: 1}).Check(events, collector); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"map[]":    true,
		"map[a:1]": true,
		"map[a:2]": true,
	}
	if !reflect.DeepEqual(seen, want) {
		t.Fatalf("got states %v, want %v", seen, want)
	}
}

// Synced writes survive every crash.
func TestSyncedWritesSurvive(t *testing.T) {
	events := []crashreplay.Event{
		{Seq: 1, Op: crashreplay.OpWrite, Key: "a", Value: "1"},
		{Seq: 2, Op: crashreplay.OpSync},
		{Seq: 3, Op: crashreplay.OpWrite, Key: "b", Value: "2"},
		{Seq: 4, Op: crashreplay.OpCrash},
	}
	inv := crashreplay.Require(map[string]string{"a": "1"})
	report, err := crashreplay.Checker{Seed: 1}.Check(events, inv)
	if err != nil {
		t.Fatal(err)
	}
	if report.Verdict != crashreplay.VerdictOK {
		t.Fatalf("got %s, want ok: %+v", report.Verdict, report)
	}
	if report.Explored != 2 {
		t.Fatalf("explored %d states, want 2", report.Explored)
	}
}

// The first counterexample is returned together with the actual recovery
// result, and the reported counterexample genuinely violates the invariant.
func TestFirstCounterexampleAndActualResult(t *testing.T) {
	events := []crashreplay.Event{
		{Seq: 1, Op: crashreplay.OpWrite, Key: "a", Value: "1"},
		{Seq: 2, Op: crashreplay.OpSync},
		{Seq: 3, Op: crashreplay.OpWrite, Key: "b", Value: "2"},
		{Seq: 4, Op: crashreplay.OpWrite, Key: "c", Value: "3"},
		{Seq: 5, Op: crashreplay.OpCrash},
	}
	inv := crashreplay.Require(map[string]string{"b": "2"})
	for _, shuffle := range []bool{false, true} {
		report, err := crashreplay.Checker{Seed: 7, Shuffle: shuffle}.Check(events, inv)
		if err != nil {
			t.Fatal(err)
		}
		if report.Verdict != crashreplay.VerdictCounterexample {
			t.Fatalf("shuffle=%v: got %s, want counterexample", shuffle, report.Verdict)
		}
		if v := inv(report.Counterexample); v == "" {
			t.Fatalf("shuffle=%v: reported counterexample %v does not violate the invariant", shuffle, report.Counterexample)
		}
		if report.Violation == "" {
			t.Fatalf("shuffle=%v: missing violation description", shuffle)
		}
		if report.Actual == nil {
			t.Fatalf("shuffle=%v: missing actual recovery result", shuffle)
		}
		if !report.ActualLegal {
			t.Fatalf("shuffle=%v: actual recovery %v is not a legal persistent subset", shuffle, report.Actual)
		}
		if report.Actual["a"] != "1" {
			t.Fatalf("shuffle=%v: actual recovery lost synced write: %v", shuffle, report.Actual)
		}
	}
}

// Without shuffling, the first counterexample for "b must persist" is the
// empty subset (durable only).
func TestFirstCounterexampleIsDeterministic(t *testing.T) {
	events := []crashreplay.Event{
		{Seq: 1, Op: crashreplay.OpWrite, Key: "a", Value: "1"},
		{Seq: 2, Op: crashreplay.OpSync},
		{Seq: 3, Op: crashreplay.OpWrite, Key: "b", Value: "2"},
		{Seq: 4, Op: crashreplay.OpCrash},
	}
	inv := crashreplay.Require(map[string]string{"b": "2"})
	report, err := crashreplay.Checker{Seed: 1}.Check(events, inv)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"a": "1"}
	if !reflect.DeepEqual(report.Counterexample, want) {
		t.Fatalf("got counterexample %v, want %v", report.Counterexample, want)
	}
}

// Budget exhausted by more than 18 unsynced writes: verdict unknown.
func TestBudgetInsufficientUnknown(t *testing.T) {
	events := append(writes(1, 19), crashreplay.Event{Seq: 20, Op: crashreplay.OpCrash})
	report, err := crashreplay.Checker{Seed: 1}.Check(events, passInvariant)
	if err != nil {
		t.Fatal(err)
	}
	if report.Verdict != crashreplay.VerdictUnknown {
		t.Fatalf("got %s, want unknown", report.Verdict)
	}
	if report.UnknownReason == "" {
		t.Fatal("missing unknown reason")
	}
	if report.Actual == nil {
		t.Fatal("actual recovery result must still be reported")
	}
}

// Exactly 18 unsynced writes fit the default budget: 2^18 subsets explored.
func TestBudgetExactly18Writes(t *testing.T) {
	events := append(writes(1, 18), crashreplay.Event{Seq: 19, Op: crashreplay.OpCrash})
	report, err := crashreplay.Checker{Seed: 1}.Check(events, passInvariant)
	if err != nil {
		t.Fatal(err)
	}
	if report.Verdict != crashreplay.VerdictOK {
		t.Fatalf("got %s, want ok", report.Verdict)
	}
	if report.Explored != 1<<18 {
		t.Fatalf("explored %d, want %d", report.Explored, 1<<18)
	}
}

// A small explicit budget also triggers unknown.
func TestExplicitBudgetUnknown(t *testing.T) {
	events := append(writes(1, 5), crashreplay.Event{Seq: 6, Op: crashreplay.OpCrash})
	report, err := crashreplay.Checker{Seed: 1, Budget: 16}.Check(events, passInvariant)
	if err != nil {
		t.Fatal(err)
	}
	if report.Verdict != crashreplay.VerdictUnknown {
		t.Fatalf("got %s, want unknown", report.Verdict)
	}
}

// Replay continues from the actual recovered state after a crash.
func TestReplayContinuesAfterCrash(t *testing.T) {
	events := []crashreplay.Event{
		{Seq: 1, Op: crashreplay.OpWrite, Key: "a", Value: "1"},
		{Seq: 2, Op: crashreplay.OpCrash},
		{Seq: 3, Op: crashreplay.OpWrite, Key: "b", Value: "2"},
		{Seq: 4, Op: crashreplay.OpSync},
		{Seq: 5, Op: crashreplay.OpCrash},
	}
	report, err := crashreplay.Checker{Seed: 3}.Check(events, passInvariant)
	if err != nil {
		t.Fatal(err)
	}
	if report.Verdict != crashreplay.VerdictOK {
		t.Fatalf("got %s, want ok: %+v", report.Verdict, report)
	}
	if report.Actual["b"] != "2" {
		t.Fatalf("actual recovery lost synced write after second crash: %v", report.Actual)
	}
}

// Duplicate sequence numbers in the publish stream are rejected.
func TestDuplicateSequenceRejected(t *testing.T) {
	events := []crashreplay.Event{
		{Seq: 1, Op: crashreplay.OpWrite, Key: "a", Value: "1"},
		{Seq: 1, Op: crashreplay.OpSync},
	}
	if _, err := crashreplay.Order(events); err == nil {
		t.Fatal("expected duplicate sequence error")
	}
	checker := crashreplay.Checker{}
	if _, err := checker.Check(events, passInvariant); err == nil {
		t.Fatal("checker must reject duplicate sequences")
	}
}

// The implementation's actual recovery is always a legal persistent subset.
func TestActualRecoveryAlwaysLegal(t *testing.T) {
	for seed := int64(0); seed < 20; seed++ {
		events := append(writes(1, 6), crashreplay.Event{Seq: 7, Op: crashreplay.OpCrash})
		report, err := crashreplay.Checker{Seed: seed}.Check(events, passInvariant)
		if err != nil {
			t.Fatal(err)
		}
		if !report.ActualLegal {
			t.Fatalf("seed %d: actual recovery %v is illegal", seed, report.Actual)
		}
	}
}

func TestLegalState(t *testing.T) {
	durable := map[string]string{"a": "1"}
	pending := []crashreplay.Write{{Key: "b", Value: "2"}, {Key: "b", Value: "3"}}
	cases := []struct {
		state map[string]string
		legal bool
	}{
		{map[string]string{"a": "1"}, true},
		{map[string]string{"a": "1", "b": "2"}, true},
		{map[string]string{"a": "1", "b": "3"}, true},
		{map[string]string{"a": "1", "b": "9"}, false}, // never written
		{map[string]string{"b": "2"}, false},           // synced write lost
		{map[string]string{"a": "2"}, false},           // synced value changed
		{map[string]string{"a": "1", "c": "1"}, false}, // unknown key
	}
	for _, tc := range cases {
		if got := crashreplay.LegalState(durable, pending, tc.state); got != tc.legal {
			t.Errorf("LegalState(%v) = %v, want %v", tc.state, got, tc.legal)
		}
	}
}
