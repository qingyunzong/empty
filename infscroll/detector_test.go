package infscroll

import (
	"strings"
	"testing"
)

func keys(ss ...string) []string { return ss }

func observeSeq(d *Detector, obs []Observation) []Verdict {
	out := make([]Verdict, 0, len(obs))
	for _, o := range obs {
		out = append(out, d.Observe(o))
	}
	return out
}

func TestStopsAfterStableStreak(t *testing.T) {
	d := New(Config{StableRounds: 2})
	verdicts := observeSeq(d, []Observation{
		{Keys: keys("a", "b"), ScrollExtent: 1000},
		{Keys: keys("a", "b"), ScrollExtent: 1000},
		{Keys: keys("a", "b"), ScrollExtent: 1000},
	})
	if verdicts[0].Decision != DecisionContinue {
		t.Fatalf("round 1: got %v, want continue (no baseline)", verdicts[0].Decision)
	}
	if verdicts[1].Decision != DecisionContinue {
		t.Fatalf("round 2: got %v, want continue (streak too short)", verdicts[1].Decision)
	}
	last := verdicts[2]
	if last.Decision != DecisionStop {
		t.Fatalf("round 3: got %v, want stop", last.Decision)
	}
	if !last.Terminal() {
		t.Fatal("stop verdict must be terminal")
	}
	if last.Evidence.StableStreak != 2 {
		t.Fatalf("streak = %d, want 2", last.Evidence.StableStreak)
	}
	for _, c := range last.Evidence.Conditions {
		if !c.Passed {
			t.Errorf("condition %s failed on stop round: %s", c.Name, c.Detail)
		}
	}
	if last.Evidence.Reason == "" {
		t.Error("stop verdict must carry a reason")
	}
}

func TestInFlightBlocksStop(t *testing.T) {
	d := New(Config{StableRounds: 2})
	verdicts := observeSeq(d, []Observation{
		{Keys: keys("a"), ScrollExtent: 500},
		{Keys: keys("a"), ScrollExtent: 500, InFlight: 1},
		{Keys: keys("a"), ScrollExtent: 500, InFlight: 1},
		{Keys: keys("a"), ScrollExtent: 500},
		{Keys: keys("a"), ScrollExtent: 500},
	})
	for i, v := range verdicts[:4] {
		if v.Decision != DecisionContinue {
			t.Fatalf("round %d: got %v, want continue", i+1, v.Decision)
		}
	}
	if verdicts[4].Decision != DecisionStop {
		t.Fatalf("round 5: got %v, want stop", verdicts[4].Decision)
	}
	// Rounds 2-3 reset the streak because of in-flight requests.
	found := false
	for _, c := range verdicts[1].Evidence.Conditions {
		if c.Name == "no_in_flight" && !c.Passed {
			found = true
		}
	}
	if !found {
		t.Error("round 2 evidence must show no_in_flight failed")
	}
}

func TestNewKeysResetStreak(t *testing.T) {
	d := New(Config{StableRounds: 2})
	verdicts := observeSeq(d, []Observation{
		{Keys: keys("a"), ScrollExtent: 500},
		{Keys: keys("a"), ScrollExtent: 500},
		{Keys: keys("a", "b"), ScrollExtent: 900, NetworkDelta: 1},
		{Keys: keys("a", "b"), ScrollExtent: 900},
		{Keys: keys("a", "b"), ScrollExtent: 900},
	})
	if verdicts[2].Decision != DecisionContinue {
		t.Fatalf("round 3: got %v, want continue after growth", verdicts[2].Decision)
	}
	if verdicts[2].Evidence.StableStreak != 0 {
		t.Fatalf("round 3 streak = %d, want 0", verdicts[2].Evidence.StableStreak)
	}
	if verdicts[4].Decision != DecisionStop {
		t.Fatalf("round 5: got %v, want stop", verdicts[4].Decision)
	}
}

func TestSentinelVisibleBlocksStop(t *testing.T) {
	d := New(Config{StableRounds: 2})
	verdicts := observeSeq(d, []Observation{
		{Keys: keys("a"), ScrollExtent: 500},
		{Keys: keys("a"), ScrollExtent: 500, SentinelVisible: true},
		{Keys: keys("a"), ScrollExtent: 500, SentinelVisible: true},
		{Keys: keys("a"), ScrollExtent: 500, SentinelVisible: true},
	})
	for i, v := range verdicts {
		if v.Decision == DecisionStop {
			t.Fatalf("round %d: stopped while sentinel visible", i+1)
		}
	}
}

func TestRecycleIsIndeterminate(t *testing.T) {
	d := New(Config{})
	verdicts := observeSeq(d, []Observation{
		{Keys: keys("a", "b", "c"), ScrollExtent: 900},
		{Keys: keys("b", "c", "d"), ScrollExtent: 1200, NetworkDelta: 1},
	})
	v := verdicts[1]
	if v.Decision != DecisionIndeterminate {
		t.Fatalf("got %v, want indeterminate", v.Decision)
	}
	if !strings.Contains(v.Evidence.Reason, "content recycling") {
		t.Fatalf("reason %q must mention content recycling", v.Evidence.Reason)
	}
	if !strings.Contains(v.Evidence.Reason, "a") {
		t.Fatalf("reason %q must name the recycled key", v.Evidence.Reason)
	}
	// Terminal verdicts are sticky.
	again := d.Observe(Observation{Keys: keys("b", "c", "d"), ScrollExtent: 1200})
	if again.Decision != DecisionIndeterminate {
		t.Fatalf("post-terminal observe got %v, want indeterminate", again.Decision)
	}
}

func TestKeyReuseIsIndeterminate(t *testing.T) {
	d := New(Config{IgnoreRecycle: true})
	verdicts := observeSeq(d, []Observation{
		{Keys: keys("a", "b"), ScrollExtent: 500},
		{Keys: keys("b"), ScrollExtent: 500},
		{Keys: keys("a", "b"), ScrollExtent: 500},
	})
	v := verdicts[2]
	if v.Decision != DecisionIndeterminate {
		t.Fatalf("got %v, want indeterminate", v.Decision)
	}
	if !strings.Contains(v.Evidence.Reason, "key reuse") {
		t.Fatalf("reason %q must mention key reuse", v.Evidence.Reason)
	}
}

func TestDuplicateKeysInRoundAreReuse(t *testing.T) {
	d := New(Config{})
	v := d.Observe(Observation{Keys: keys("a", "a", "b"), ScrollExtent: 500})
	if v.Decision != DecisionIndeterminate {
		t.Fatalf("got %v, want indeterminate", v.Decision)
	}
	if !strings.Contains(v.Evidence.Reason, "duplicate") {
		t.Fatalf("reason %q must mention duplicates", v.Evidence.Reason)
	}
}

func TestExtentEpsilon(t *testing.T) {
	d := New(Config{StableRounds: 2, ExtentEpsilon: 1.0})
	verdicts := observeSeq(d, []Observation{
		{Keys: keys("a"), ScrollExtent: 500.0},
		{Keys: keys("a"), ScrollExtent: 500.5},
		{Keys: keys("a"), ScrollExtent: 501.0},
	})
	if verdicts[2].Decision != DecisionStop {
		t.Fatalf("got %v, want stop within epsilon", verdicts[2].Decision)
	}
}

func TestContinueEvidenceNamesFailedConditions(t *testing.T) {
	d := New(Config{})
	d.Observe(Observation{Keys: keys("a"), ScrollExtent: 500})
	v := d.Observe(Observation{Keys: keys("a", "b"), ScrollExtent: 800, NetworkDelta: 2, InFlight: 1})
	if v.Decision != DecisionContinue {
		t.Fatalf("got %v, want continue", v.Decision)
	}
	for _, name := range []string{"no_new_keys", "extent_stable", "network_quiet", "no_in_flight"} {
		if !strings.Contains(v.Evidence.Reason, name) {
			t.Errorf("reason %q must name failed condition %s", v.Evidence.Reason, name)
		}
	}
}

func TestTerminalHelper(t *testing.T) {
	if (Verdict{Decision: DecisionContinue}).Terminal() {
		t.Error("continue must not be terminal")
	}
	if !(Verdict{Decision: DecisionStop}).Terminal() {
		t.Error("stop must be terminal")
	}
	if !(Verdict{Decision: DecisionIndeterminate}).Terminal() {
		t.Error("indeterminate must be terminal")
	}
}
