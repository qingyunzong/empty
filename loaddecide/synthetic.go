package loaddecide

import (
	"math"
	"math/rand"
)

// SyntheticCurve models an offered-load response curve: successful throughput
// saturates at CapacityRPS, queueing latency rises as utilization approaches
// one, and requests past OverloadRPS are rejected with a growing probability.
// It is deterministic for a fixed seed and intended for validating the
// decider against a known knee.
type SyntheticCurve struct {
	// CapacityRPS is the service capacity where throughput saturates.
	CapacityRPS float64
	// BaseLatencyMS is the zero-load service latency.
	BaseLatencyMS float64
	// OverloadRPS is the offered load at which rejections begin.
	OverloadRPS float64
	// RejectionSlope is the extra rejection probability per RPS above overload.
	RejectionSlope float64
	// WindowSeconds is the simulated duration of one throughput window.
	WindowSeconds float64
	// JitterCV is the coefficient of variation of per-request latency. Zero
	// (the default) keeps the classic exponential service-time model; a positive
	// value switches to a tighter Gaussian jitter around the queueing mean,
	// which produces low-variance throughput windows for saturation tests.
	JitterCV float64
	// WindowNoiseCV adds Gaussian relative noise to the observed successful
	// throughput of each window (0 disables it). It models scheduling and
	// sampling noise without changing the underlying capacity saturation.
	WindowNoiseCV float64

	rng *rand.Rand
}

// NewSyntheticCurve builds a curve. A zero OverloadRPS defaults to the
// capacity itself.
func NewSyntheticCurve(capacityRPS, baseLatencyMS, overloadRPS, rejectionSlope, windowSeconds float64, seed int64) *SyntheticCurve {
	if overloadRPS == 0 {
		overloadRPS = capacityRPS
	}
	return &SyntheticCurve{
		CapacityRPS:    capacityRPS,
		BaseLatencyMS:  baseLatencyMS,
		OverloadRPS:    overloadRPS,
		RejectionSlope: rejectionSlope,
		WindowSeconds:  windowSeconds,
		rng:            rand.New(rand.NewSource(seed)),
	}
}

// utilization returns the bounded server utilization at the offered load.
func (c *SyntheticCurve) utilization(offeredRPS float64) float64 {
	return math.Min(0.999, offeredRPS/c.CapacityRPS)
}

// rejectionProbability returns the per-request rejection probability.
func (c *SyntheticCurve) rejectionProbability(offeredRPS float64) float64 {
	if offeredRPS <= c.OverloadRPS {
		return 0
	}
	return math.Min(0.99, (offeredRPS-c.OverloadRPS)*c.RejectionSlope)
}

// meanLatencyMS models queueing plus service latency: base/(1-utilization).
func (c *SyntheticCurve) meanLatencyMS(offeredRPS float64) float64 {
	return c.BaseLatencyMS / (1 - c.utilization(offeredRPS))
}

// Sample produces one observation at the given offered load. Latency is drawn
// from an exponential distribution around the queueing mean, and failures
// follow the overload rejection probability.
func (c *SyntheticCurve) Sample(offeredRPS float64) Observation {
	failed := c.rng.Float64() < c.rejectionProbability(offeredRPS)
	mean := c.meanLatencyMS(offeredRPS)
	latency := mean * c.rng.ExpFloat64()
	if c.JitterCV > 0 {
		latency = math.Max(c.BaseLatencyMS, mean+mean*c.JitterCV*c.rng.NormFloat64())
	}
	return Observation{LatencyMS: latency, Failed: failed}
}

// RunWindow simulates one full throughput window at the offered load and
// returns the window counters plus every individual observation.
func (c *SyntheticCurve) RunWindow(offeredRPS float64) (ThroughputWindow, []Observation) {
	requests := int(math.Round(offeredRPS * c.WindowSeconds))
	window := ThroughputWindow{Requests: requests}
	observations := make([]Observation, 0, requests)
	for range requests {
		obs := c.Sample(offeredRPS)
		if obs.Failed {
			window.Errors++
		}
		observations = append(observations, obs)
	}
	// Throughput is what the server actually completes: offered load is capped
	// at service capacity, then overloaded requests are rejected, and optional
	// sampling noise is applied. This makes the observed throughput curve bend
	// over at CapacityRPS instead of tracking the offered load indefinitely.
	capacity := c.CapacityRPS * c.WindowSeconds
	served := math.Min(float64(requests-window.Errors), capacity)
	if c.WindowNoiseCV > 0 && served > 0 {
		served = math.Max(0, served+served*c.WindowNoiseCV*c.rng.NormFloat64())
	}
	window.Errors = requests - int(math.Round(math.Min(float64(requests), served)))
	return window, observations
}

// RoundPlan describes how many warmup and measured windows to run per level.
type RoundPlan struct {
	WarmupWindows   int
	MeasuredWindows int
}

// RoundOutcome is the controller-side record of one evaluated level.
type RoundOutcome struct {
	LevelIndex int
	Load       float64
	Verdict    LevelVerdict
	Bracket    Bracket
}

// RunScenario drives a decider through the curve until it terminates or the
// round cap is reached, returning one outcome per judged level. Warmup and
// measured samples are fed through the separate decider entry points.
func RunScenario(decider *Decider, curve *SyntheticCurve, plan RoundPlan, roundCap int) ([]RoundOutcome, error) {
	var outcomes []RoundOutcome
	for decider.Status() == StatusRunning && len(outcomes) < roundCap {
		load, index, ok := decider.NextLevel()
		if !ok {
			break
		}

		for range plan.WarmupWindows {
			_, observations := curve.RunWindow(load)
			for _, obs := range observations {
				if err := decider.AddWarmup(obs); err != nil {
					return nil, err
				}
			}
		}

		for range plan.MeasuredWindows {
			window, observations := curve.RunWindow(load)
			if err := decider.AddWindow(window); err != nil {
				return nil, err
			}
			for _, obs := range observations {
				if err := decider.AddMeasured(obs); err != nil {
					return nil, err
				}
			}
		}

		verdict, err := decider.Evaluate()
		if err != nil {
			return nil, err
		}
		if verdict.Verdict == VerdictUnknown {
			// Precision not reached yet; in a real controller the loop keeps
			// feeding the same level. The fixed plan exhausts budgets instead,
			// which is exactly the unclosed-interval path under test.
			if decider.Status() == StatusRunning {
				return outcomes, nil
			}
		}
		outcomes = append(outcomes, RoundOutcome{
			LevelIndex: index,
			Load:       load,
			Verdict:    verdict,
			Bracket:    decider.Bracket(),
		})
	}
	return outcomes, nil
}
