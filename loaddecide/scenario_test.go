package loaddecide

import (
	"math"
	"testing"
)

func testLevels() []float64 {
	levels := make([]float64, 15)
	for i := range levels {
		levels[i] = 100 * float64(i+1) // 100..1500 RPS
	}
	return levels
}

// testCurve has a known knee: capacity 850 RPS, rejections start at 900.
func testCurve(seed int64) *SyntheticCurve {
	return NewSyntheticCurve(
		850,   // capacity
		8,     // base latency ms
		900,   // overload onset
		0.004, // +0.4% rejection per RPS above overload
		1.0,   // one-second windows
		seed,
	)
}

func testConfig(levels []float64) Config {
	return Config{
		Levels:            levels,
		MaxSafeLevelIndex: 12, // ceiling 1300 RPS, below the 1500 list top
		StartLevelIndex:   0,
		Confidence:        0.95,
		SLO: SLOConfig{
			MaxLatencyQuantileMS: 120,
			MaxErrorRate:         0.05,
			LatencyQuantile:      0.99,
			SaturationGainFloor:  0.05,
		},
		Precision: PrecisionConfig{
			MinWindows:           6,
			MinRequests:          400,
			MaxThroughputCIWidth: 90,
			MaxLatencyCIWidth:    60,
			MaxErrorCIWidth:      0.08,
		},
		Budget: Budget{MaxRounds: 30},
	}
}

func TestSyntheticCurveFindsKneeAndRespectsCeiling(t *testing.T) {
	levels := testLevels()
	cfg := testConfig(levels)
	decider, err := NewDecider(cfg)
	if err != nil {
		t.Fatalf("NewDecider: %v", err)
	}
	curve := testCurve(20261118)

	outcomes, err := RunScenario(decider, curve, RoundPlan{WarmupWindows: 2, MeasuredWindows: 8}, 40)
	if err != nil {
		t.Fatalf("RunScenario: %v", err)
	}
	result := decider.Result()
	if result == nil {
		t.Fatalf("search did not terminate: status=%s outcomes=%d", decider.Status(), len(outcomes))
	}
	if result.Status != StatusClosed {
		t.Fatalf("expected closed knee bracket, got status=%s reason=%s", result.Status, result.Reason)
	}

	// The knee must be bracketed, lie below the known overload onset, and never
	// exceed the configured safety ceiling.
	if result.HighestSafeIndex < 0 || result.BoundingUnsafeIndex <= result.HighestSafeIndex {
		t.Fatalf("invalid bracket: %+v", result)
	}
	if levels[result.BoundingUnsafeIndex] > levels[cfg.MaxSafeLevelIndex] {
		t.Fatalf("search crossed safety ceiling: unsafe=%v ceiling=%v",
			levels[result.BoundingUnsafeIndex], levels[cfg.MaxSafeLevelIndex])
	}
	if levels[result.HighestSafeIndex] >= curve.OverloadRPS {
		t.Fatalf("highest safe level %v must stay below overload onset %v",
			levels[result.HighestSafeIndex], curve.OverloadRPS)
	}
	for _, o := range outcomes {
		if o.LevelIndex > cfg.MaxSafeLevelIndex {
			t.Fatalf("probed level above ceiling: %d", o.LevelIndex)
		}
		if o.Bracket.HighLevel > cfg.MaxSafeLevelIndex && o.Bracket.HighLevel >= 0 {
			t.Fatalf("bracket high bound above ceiling: %+v", o.Bracket)
		}
	}

	lowLoad, highLoad := result.LoadInterval(levels)
	if math.IsNaN(lowLoad) || math.IsNaN(highLoad) || lowLoad >= highLoad {
		t.Fatalf("closed load interval invalid: low=%v high=%v", lowLoad, highLoad)
	}
	t.Logf("knee bracket: [%.0f, %.0f) RPS across %d rounds, reason=%s",
		lowLoad, highLoad, len(outcomes), result.Reason)
}

func TestBracketShrinksRoundByRound(t *testing.T) {
	levels := testLevels()
	decider, err := NewDecider(testConfig(levels))
	if err != nil {
		t.Fatalf("NewDecider: %v", err)
	}
	curve := testCurve(424242)
	outcomes, err := RunScenario(decider, curve, RoundPlan{WarmupWindows: 1, MeasuredWindows: 8}, 40)
	if err != nil {
		t.Fatalf("RunScenario: %v", err)
	}
	if len(outcomes) < 3 {
		t.Fatalf("need several rounds to assert shrinkage, got %d", len(outcomes))
	}

	// The low bound is non-decreasing, the high bound never moves upward once
	// set, and once closed the index width is strictly decreasing.
	prevLow := -1
	prevHigh := math.MaxInt
	closedWidths := []int{}
	for i, o := range outcomes {
		if o.Bracket.LowLevel < prevLow {
			t.Fatalf("round %d: low bound regressed %d -> %d", i, prevLow, o.Bracket.LowLevel)
		}
		if o.Bracket.HighLevel >= 0 && o.Bracket.HighLevel > prevHigh {
			t.Fatalf("round %d: high bound expanded %d -> %d", i, prevHigh, o.Bracket.HighLevel)
		}
		if o.Bracket.Closed {
			closedWidths = append(closedWidths, o.Bracket.HighLevel-o.Bracket.LowLevel)
		}
		prevLow = o.Bracket.LowLevel
		if o.Bracket.HighLevel >= 0 {
			prevHigh = o.Bracket.HighLevel
		}
	}
	for i := 1; i < len(closedWidths); i++ {
		if closedWidths[i] >= closedWidths[i-1] {
			t.Fatalf("closed bracket width did not shrink: %v", closedWidths)
		}
	}

	// Every adjacent step moves at most one level at a time (no aggressive jumps).
	for i := 1; i < len(outcomes); i++ {
		jump := outcomes[i].LevelIndex - outcomes[i-1].LevelIndex
		if jump != 1 {
			t.Fatalf("round %d jumped %d levels; adjacent stepping required", i, jump)
		}
	}
}

func TestBudgetExhaustionReturnsUnclosedInterval(t *testing.T) {
	levels := testLevels()
	cfg := testConfig(levels)
	// Only two judged rounds fit in the budget; the knee near level 8 cannot be
	// reached, so the result must stay open on the high side.
	cfg.Budget = Budget{MaxRounds: 2}
	decider, err := NewDecider(cfg)
	if err != nil {
		t.Fatalf("NewDecider: %v", err)
	}
	curve := testCurve(7)
	outcomes, err := RunScenario(decider, curve, RoundPlan{WarmupWindows: 1, MeasuredWindows: 8}, 40)
	if err != nil {
		t.Fatalf("RunScenario: %v", err)
	}
	result := decider.Result()
	if result == nil {
		t.Fatalf("expected terminal result, got outcomes=%d", len(outcomes))
	}
	if result.Status != StatusExhausted || result.Closed {
		t.Fatalf("expected exhausted/unclosed, got status=%s closed=%v", result.Status, result.Closed)
	}
	if result.BoundingUnsafeIndex != -1 || result.Bracket().HighOpen != true {
		t.Fatalf("unclosed bracket must have no high bound: %+v", result.Bracket())
	}
	lowLoad, highLoad := result.LoadInterval(levels)
	if !math.IsNaN(highLoad) || math.IsNaN(lowLoad) {
		t.Fatalf("unclosed load interval must be [low, NaN): got [%v, %v)", lowLoad, highLoad)
	}
	if decider.RoundsUsed() > cfg.Budget.MaxRounds {
		t.Fatalf("round budget exceeded: used=%d", decider.RoundsUsed())
	}
}

func TestRequestBudgetExhaustionUnclosed(t *testing.T) {
	levels := testLevels()
	cfg := testConfig(levels)
	cfg.Budget = Budget{MaxMeasuredRequests: 1600} // ~two levels at 800 req/level
	decider, err := NewDecider(cfg)
	if err != nil {
		t.Fatalf("NewDecider: %v", err)
	}
	curve := testCurve(99)
	if _, err := RunScenario(decider, curve, RoundPlan{WarmupWindows: 1, MeasuredWindows: 8}, 40); err != nil {
		t.Fatalf("RunScenario: %v", err)
	}
	result := decider.Result()
	if result == nil || result.Status != StatusExhausted || result.Closed {
		t.Fatalf("expected request-budget exhaustion with unclosed bracket, got %+v", result)
	}
	if decider.MeasuredRequests() > cfg.Budget.MaxMeasuredRequests+1500 {
		t.Fatalf("request budget not honored: used=%d", decider.MeasuredRequests())
	}
}

func TestCeilingStopsBeforeUnsafeLevel(t *testing.T) {
	levels := testLevels()
	cfg := testConfig(levels)
	cfg.MaxSafeLevelIndex = 3 // ceiling 400 RPS, well below the curve knee
	cfg.Budget = Budget{MaxRounds: 30}
	decider, err := NewDecider(cfg)
	if err != nil {
		t.Fatalf("NewDecider: %v", err)
	}
	curve := testCurve(11)
	outcomes, err := RunScenario(decider, curve, RoundPlan{WarmupWindows: 1, MeasuredWindows: 8}, 40)
	if err != nil {
		t.Fatalf("RunScenario: %v", err)
	}
	result := decider.Result()
	if result == nil || result.Status != StatusCeiling {
		t.Fatalf("expected ceiling termination, got %+v outcomes=%d", result, len(outcomes))
	}
	if result.HighestSafeIndex != cfg.MaxSafeLevelIndex {
		t.Fatalf("ceiling level should be proven safe: %+v", result)
	}
	for _, o := range outcomes {
		if o.LevelIndex > cfg.MaxSafeLevelIndex {
			t.Fatalf("ceiling violated at level %d", o.LevelIndex)
		}
	}
}

func TestWarmupNeverDrivesVerdict(t *testing.T) {
	levels := testLevels()
	cfg := testConfig(levels)
	decider, err := NewDecider(cfg)
	if err != nil {
		t.Fatalf("NewDecider: %v", err)
	}
	curve := testCurve(1234)

	load, index, ok := decider.NextLevel()
	if !ok || index != 0 {
		t.Fatalf("first level must be the start index")
	}
	// Poison the warmup phase with extreme latency; it must be quarantined.
	for range 200 {
		if err := decider.AddWarmup(Observation{LatencyMS: 100000, Failed: true}); err != nil {
			t.Fatalf("AddWarmup: %v", err)
		}
	}
	for range 8 {
		window, observations := curve.RunWindow(load)
		if err := decider.AddWindow(window); err != nil {
			t.Fatal(err)
		}
		for _, obs := range observations {
			if err := decider.AddMeasured(obs); err != nil {
				t.Fatal(err)
			}
		}
	}
	verdict, err := decider.Evaluate()
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if verdict.Verdict != VerdictSafe {
		t.Fatalf("warmup pollution altered verdict: %v (%s)", verdict.Verdict, verdict.Reason)
	}
}

func TestConfigValidation(t *testing.T) {
	if _, err := NewDecider(Config{Levels: nil}); err == nil {
		t.Fatalf("empty levels must be rejected")
	}
	levels := testLevels()
	bad := testConfig(levels)
	bad.Levels = []float64{1, 1, 2}
	if _, err := NewDecider(bad); err == nil {
		t.Fatalf("non-ascending levels must be rejected")
	}
	bad = testConfig(levels)
	bad.MaxSafeLevelIndex = 99
	if _, err := NewDecider(bad); err == nil {
		t.Fatalf("out-of-range ceiling must be rejected")
	}
	bad = testConfig(levels)
	bad.SLO.LatencyQuantile = 1.5
	if _, err := NewDecider(bad); err == nil {
		t.Fatalf("invalid quantile must be rejected")
	}
	bad = testConfig(levels)
	bad.StartLevelIndex = bad.MaxSafeLevelIndex + 1
	if _, err := NewDecider(bad); err == nil {
		t.Fatalf("start above ceiling must be rejected")
	}
}
