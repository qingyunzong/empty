package loaddecide

import "testing"

// TestConfidenceIntervalsShrinkWithSamples verifies that every interval type
// narrows as more jitter samples accumulate, which is what makes the per-round
// bracket converge rather than oscillate.
func TestConfidenceIntervalsShrinkWithSamples(t *testing.T) {
	curve := NewSyntheticCurve(850, 8, 900, 0.004, 1.0, 2026)
	curve.WindowNoiseCV = 0.05
	const offered = 600.0

	type widths struct {
		throughput float64
		quantile   float64
		errorRate  float64
	}
	measure := func(windows int) widths {
		c := NewCollector(0.95)
		c.BeginMeasured()
		for range windows {
			window, observations := curve.RunWindow(offered)
			c.AddWindow(window)
			for _, obs := range observations {
				c.AddMeasured(obs)
			}
		}
		stats, err := c.Snapshot(0, 0.99)
		if err != nil {
			t.Fatalf("snapshot after %d windows: %v", windows, err)
		}
		return widths{
			throughput: stats.Throughput.Width(),
			quantile:   stats.LatencyQuantile.Width(),
			errorRate:  stats.ErrorRate.Width(),
		}
	}

	small := measure(6)
	large := measure(48)
	if !(large.throughput < small.throughput) {
		t.Fatalf("throughput CI did not shrink: %v -> %v", small.throughput, large.throughput)
	}
	if !(large.quantile < small.quantile) {
		t.Fatalf("quantile CI did not shrink: %v -> %v", small.quantile, large.quantile)
	}
	if !(large.errorRate < small.errorRate) {
		t.Fatalf("error-rate CI did not shrink: %v -> %v", small.errorRate, large.errorRate)
	}
}

// TestBracketMonotonicAcrossSeeds repeats the full search over several seeds
// and asserts each run produces adjacent, non-regressing bracket updates and a
// closed bracket inside the safety ceiling.
func TestBracketMonotonicAcrossSeeds(t *testing.T) {
	levels := testLevels()
	for _, seed := range []int64{101, 202, 303, 404} {
		decider, err := NewDecider(testConfig(levels))
		if err != nil {
			t.Fatalf("NewDecider: %v", err)
		}
		outcomes, err := RunScenario(decider, testCurve(seed), RoundPlan{WarmupWindows: 1, MeasuredWindows: 8}, 40)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		result := decider.Result()
		if result == nil || result.Status != StatusClosed {
			t.Fatalf("seed %d: expected closed result, got %+v", seed, result)
		}
		prevLevel := -1
		prevLow := -1
		for i, o := range outcomes {
			if o.Bracket.LowLevel < prevLow {
				t.Fatalf("seed %d round %d: low bound regressed", seed, i)
			}
			if o.LevelIndex <= prevLevel {
				t.Fatalf("seed %d round %d: level did not advance", seed, i)
			}
			prevLow = o.Bracket.LowLevel
			prevLevel = o.LevelIndex
		}
		if result.BoundingUnsafeIndex > decider.cfg.MaxSafeLevelIndex {
			t.Fatalf("seed %d: ceiling crossed", seed)
		}
	}
}
