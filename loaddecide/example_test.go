package loaddecide_test

import (
	"fmt"

	"example.org/dlks/formal/q10189/loaddecide"
)

// Example shows the round-by-round controller loop: probe a level with warmup
// then measured samples, evaluate the confidence intervals, and read the
// saturation knee bracket when the search terminates.
func Example() {
	levels := []float64{100, 200, 300, 400, 600, 800, 1000, 1200}
	decider, err := loaddecide.NewDecider(loaddecide.Config{
		Levels:            levels,
		MaxSafeLevelIndex: 6, // hard safety ceiling: never apply 1200 RPS
		Confidence:        0.95,
		SLO: loaddecide.SLOConfig{
			MaxLatencyQuantileMS: 100,
			MaxErrorRate:         0.02,
			LatencyQuantile:      0.99,
			SaturationGainFloor:  0.05,
		},
		Precision: loaddecide.PrecisionConfig{
			MinWindows:  6,
			MinRequests: 300,
		},
		Budget: loaddecide.Budget{MaxRounds: 20, MaxMeasuredRequests: 200000},
	})
	if err != nil {
		panic(err)
	}

	curve := loaddecide.NewSyntheticCurve(700, 8, 750, 0.005, 1.0, 1)
	for decider.Status() == loaddecide.StatusRunning {
		load, _, ok := decider.NextLevel()
		if !ok {
			break
		}

		// Warmup phase: discarded from all confidence intervals.
		for range 2 {
			_, observations := curve.RunWindow(load)
			for _, obs := range observations {
				_ = decider.AddWarmup(obs)
			}
		}

		// Jitter phase: keep feeding until the precision gate is satisfied.
		for {
			window, observations := curve.RunWindow(load)
			_ = decider.AddWindow(window)
			for _, obs := range observations {
				_ = decider.AddMeasured(obs)
			}
			verdict, err := decider.Evaluate()
			if err != nil {
				panic(err)
			}
			if verdict.Verdict != loaddecide.VerdictUnknown ||
				decider.Status() != loaddecide.StatusRunning {
				break
			}
		}
	}

	result := decider.Result()
	lowLoad, highLoad := result.LoadInterval(levels)
	fmt.Printf("status=%s closed=%v knee=[%.0f,%.0f)\n",
		result.Status, result.Closed, lowLoad, highLoad)
	// Output: status=closed closed=true knee=[400,600)
}
