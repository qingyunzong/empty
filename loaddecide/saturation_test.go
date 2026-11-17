package loaddecide

import (
	"testing"
)

// TestSaturationKneeBeforeSLOSweep builds a curve whose latency and error SLOs
// stay satisfied across every admissible level, but whose throughput flattens
// at the capacity ceiling. The decider must still close a bracket using the
// saturation criterion rather than running into the safety ceiling.
func TestSaturationKneeBeforeSLOSweep(t *testing.T) {
	levels := testLevels()
	cfg := testConfig(levels)
	// Loose SLOs: only throughput flattening can close the bracket.
	cfg.SLO.MaxLatencyQuantileMS = 1e9
	cfg.SLO.MaxErrorRate = 0.999
	cfg.SLO.SaturationGainFloor = 0.08
	cfg.MaxSafeLevelIndex = 12
	// Exponential service times have high variance; the saturation test focuses
	// on throughput shape, so relax width gates and collect more windows.
	cfg.Precision.MaxThroughputCIWidth = 220
	cfg.Precision.MaxLatencyCIWidth = 0
	cfg.Precision.MaxErrorCIWidth = 0

	decider, err := NewDecider(cfg)
	if err != nil {
		t.Fatalf("NewDecider: %v", err)
	}
	// Capacity 500 RPS, no rejections at all, so SLOs never trip but the
	// throughput curve saturates beyond 500 RPS.
	curve := NewSyntheticCurve(500, 8, 1e9, 0, 1.0, 555)
	curve.JitterCV = 0.1
	curve.WindowNoiseCV = 0.03

	outcomes, err := RunScenario(decider, curve, RoundPlan{WarmupWindows: 1, MeasuredWindows: 12}, 40)
	if err != nil {
		t.Fatalf("RunScenario: %v", err)
	}
	result := decider.Result()
	if result == nil {
		t.Fatalf("search did not terminate: outcomes=%d", len(outcomes))
	}
	if result.Status != StatusClosed {
		t.Fatalf("expected saturation closure, got status=%s reason=%s", result.Status, result.Reason)
	}
	if result.Reason != ReasonSaturationKnee {
		t.Fatalf("expected saturation reason, got %s", result.Reason)
	}
	if levels[result.HighestSafeIndex] > curve.CapacityRPS {
		t.Fatalf("knee above capacity: safe=%v capacity=%v",
			levels[result.HighestSafeIndex], curve.CapacityRPS)
	}
	if result.BoundingUnsafeIndex != result.HighestSafeIndex+1 {
		t.Fatalf("saturation bracket must be adjacent: %+v", result.Bracket())
	}
	for _, o := range outcomes {
		if o.LevelIndex > cfg.MaxSafeLevelIndex {
			t.Fatalf("ceiling violated: %d", o.LevelIndex)
		}
	}
	t.Logf("saturation knee bracket: [%.0f, %.0f) RPS over %d rounds",
		levels[result.HighestSafeIndex], levels[result.BoundingUnsafeIndex], len(outcomes))
}

// TestUnknownVerdictKeepsSameLevel simulates a controller that keeps feeding a
// level until precision is reached, instead of relying on the scenario helper.
func TestUnknownVerdictKeepsSameLevel(t *testing.T) {
	levels := testLevels()
	decider, err := NewDecider(testConfig(levels))
	if err != nil {
		t.Fatalf("NewDecider: %v", err)
	}
	curve := testCurve(808)

	_, index, ok := decider.NextLevel()
	if !ok || index != 0 {
		t.Fatalf("unexpected initial level: %d", index)
	}

	// Feed one window at a time; while precision is insufficient the level must
	// stay fixed and the search must remain running.
	iterations := 0
	for decider.Status() == StatusRunning {
		iterations++
		window, observations := curve.RunWindow(levels[index])
		if err := decider.AddWindow(window); err != nil {
			t.Fatal(err)
		}
		for _, obs := range observations {
			if err := decider.AddMeasured(obs); err != nil {
				t.Fatal(err)
			}
		}
		verdict, err := decider.Evaluate()
		if err != nil {
			t.Fatalf("Evaluate: %v", err)
		}
		if verdict.Verdict == VerdictUnknown {
			if decider.Status() != StatusRunning {
				t.Fatalf("unknown verdict with remaining budget must keep running")
			}
			_, sameIndex, stillOK := decider.NextLevel()
			if !stillOK || sameIndex != index {
				t.Fatalf("unknown verdict must not advance the level: %d -> %d", index, sameIndex)
			}
		} else {
			_, nextIndex, _ := decider.NextLevel()
			if decider.Status() == StatusRunning && nextIndex != index+1 {
				t.Fatalf("safe verdict must advance exactly one level: %d -> %d", index, nextIndex)
			}
			break
		}
		if iterations > 30 {
			t.Fatalf("precision never reached")
		}
	}
	if decider.RoundsUsed() != 1 {
		t.Fatalf("exactly one level should be judged, got %d rounds", decider.RoundsUsed())
	}
}

// TestTerminationReasonAndStatusStrings exercises the diagnostic accessors and
// their string forms.
func TestTerminationReasonAndStatusStrings(t *testing.T) {
	statuses := map[Status]string{
		StatusRunning:   "running",
		StatusClosed:    "closed",
		StatusCeiling:   "ceiling",
		StatusExhausted: "exhausted",
	}
	for status, want := range statuses {
		if status.String() != want {
			t.Fatalf("status %d string = %q, want %q", status, status.String(), want)
		}
	}

	levels := testLevels()
	cfg := testConfig(levels)
	cfg.Budget = Budget{MaxRounds: 1}
	decider, err := NewDecider(cfg)
	if err != nil {
		t.Fatalf("NewDecider: %v", err)
	}
	if _, err := RunScenario(decider, testCurve(13), RoundPlan{WarmupWindows: 1, MeasuredWindows: 8}, 10); err != nil {
		t.Fatalf("RunScenario: %v", err)
	}
	if decider.Status() != StatusExhausted || decider.TerminationReason() == "" {
		t.Fatalf("expected exhausted status with a recorded reason, got %s/%q",
			decider.Status(), decider.TerminationReason())
	}
}
