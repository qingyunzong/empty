package loaddecide

import (
	"errors"
	"math"
	"sort"
)

// Observation is one completed request attempt sampled during a run.
type Observation struct {
	// LatencyMS is the end-to-end request latency in milliseconds.
	LatencyMS float64
	// Failed marks a request counted toward the error-rate numerator.
	Failed bool
}

// ErrWarmupClosed is returned when warmup observations are submitted after the
// collector has moved into the measured (jitter) phase. The two sample pools
// must never be mixed.
var ErrWarmupClosed = errors.New("loaddecide: warmup phase is closed")

// ErrEmptyCollector is returned when statistics are requested from a collector
// that has no measured samples.
var ErrEmptyCollector = errors.New("loaddecide: no measured observations")

// ThroughputWindow is one fixed-length measurement window, e.g. one second.
type ThroughputWindow struct {
	// Requests is the number of measured requests completed in the window.
	Requests int
	// Errors is the number of failed measured requests in the window.
	Errors int
}

// SuccessRate returns the successful-request count, used as the throughput
// sample for this window.
func (w ThroughputWindow) SuccessRate() float64 {
	return float64(w.Requests - w.Errors)
}

// Collector accumulates samples for a single load level. Warmup and jitter
// (measured) observations are kept in separate pools: warmup data is retained
// for diagnostics but is never used to compute confidence intervals.
type Collector struct {
	confidence float64

	warmupRequests int
	warmupErrors   int

	measuredRequests int
	measuredErrors   int
	latencies        []float64
	windows          []float64
	measuring        bool
}

// NewCollector creates an empty collector for the given confidence level
// (0 < confidence < 1, typically 0.95).
func NewCollector(confidence float64) *Collector {
	return &Collector{confidence: confidence}
}

// AddWarmup records a warmup-phase observation. It fails once BeginMeasured
// has been called, enforcing that warmup and jitter samples stay separate.
func (c *Collector) AddWarmup(obs Observation) error {
	if c.measuring {
		return ErrWarmupClosed
	}
	c.warmupRequests++
	if obs.Failed {
		c.warmupErrors++
	}
	return nil
}

// BeginMeasured closes the warmup phase. Subsequent AddWarmup calls fail.
func (c *Collector) BeginMeasured() {
	c.measuring = true
}

// AddMeasured records a jitter-phase request observation.
func (c *Collector) AddMeasured(obs Observation) {
	c.measuring = true
	c.measuredRequests++
	if obs.Failed {
		c.measuredErrors++
	} else {
		c.latencies = append(c.latencies, obs.LatencyMS)
	}
}

// AddWindow records a completed throughput window. The stored sample is the
// successful request count of the window, so degradation is visible even if
// the offered load stays constant.
func (c *Collector) AddWindow(window ThroughputWindow) {
	c.measuring = true
	c.windows = append(c.windows, window.SuccessRate())
}

// WarmupRequests reports how many warmup observations were recorded.
func (c *Collector) WarmupRequests() int { return c.warmupRequests }

// MeasuredRequests reports how many jitter-phase observations were recorded.
func (c *Collector) MeasuredRequests() int { return c.measuredRequests }

// WindowCount reports the number of completed throughput windows.
func (c *Collector) WindowCount() int { return len(c.windows) }

// LevelStats is the confidence-interval snapshot of one measured level.
type LevelStats struct {
	LevelIndex int

	Requests int
	Errors   int
	// ErrorRate is the Wilson interval for errors/requests.
	ErrorRate Interval

	// LatencyQuantile is the order-statistic interval for the configured
	// latency quantile, computed over successful measured requests.
	LatencyQuantile QuantileInterval

	// Throughput is the Student-t interval over per-window successful
	// request counts.
	Throughput MeanInterval
}

// Snapshot computes all confidence intervals from the measured sample pool.
// Warmup samples are deliberately excluded.
func (c *Collector) Snapshot(levelIndex int, latencyQuantile float64) (LevelStats, error) {
	if c.measuredRequests == 0 {
		return LevelStats{}, ErrEmptyCollector
	}
	sortedLatencies := append([]float64(nil), c.latencies...)
	sort.Float64s(sortedLatencies)
	return LevelStats{
		LevelIndex:      levelIndex,
		Requests:        c.measuredRequests,
		Errors:          c.measuredErrors,
		ErrorRate:       wilsonInterval(c.measuredErrors, c.measuredRequests, c.confidence),
		LatencyQuantile: quantileConfidenceInterval(sortedLatencies, latencyQuantile, c.confidence),
		Throughput:      meanConfidenceInterval(c.windows, c.confidence),
	}, nil
}

// PrecisionConfig sets the minimum evidence and precision required before a
// level can be judged. Zero-valued optional limits disable that check.
type PrecisionConfig struct {
	// MinWindows is the minimum number of throughput windows.
	MinWindows int
	// MinRequests is the minimum number of measured requests.
	MinRequests int
	// MaxThroughputCIWidth rejects the level while the throughput CI is wider.
	MaxThroughputCIWidth float64
	// MaxLatencyCIWidth rejects the level while the quantile CI is wider.
	MaxLatencyCIWidth float64
	// MaxErrorCIWidth rejects the level while the error-rate CI is wider.
	MaxErrorCIWidth float64
}

// PrecisionGate reports whether a level has collected enough precise evidence
// to support a safety verdict. NaN interval bounds count as insufficient.
type PrecisionGate struct {
	Config PrecisionConfig
}

// Sufficient reports whether the stats pass every active precision check.
func (g PrecisionGate) Sufficient(stats LevelStats) (bool, string) {
	cfg := g.Config
	if stats.Requests < cfg.MinRequests {
		return false, ReasonInsufficientRequests
	}
	if stats.Throughput.N < cfg.MinWindows {
		return false, ReasonInsufficientWindows
	}
	if math.IsNaN(stats.Throughput.Lower) || math.IsNaN(stats.Throughput.Upper) {
		return false, ReasonInsufficientWindows
	}
	if cfg.MaxThroughputCIWidth > 0 && stats.Throughput.Width() > cfg.MaxThroughputCIWidth {
		return false, ReasonThroughputCIWide
	}
	if math.IsNaN(stats.LatencyQuantile.Lower) || math.IsNaN(stats.LatencyQuantile.Upper) {
		return false, ReasonLatencyCIWide
	}
	if cfg.MaxLatencyCIWidth > 0 && stats.LatencyQuantile.Width() > cfg.MaxLatencyCIWidth {
		return false, ReasonLatencyCIWide
	}
	if math.IsNaN(stats.ErrorRate.Lower) || math.IsNaN(stats.ErrorRate.Upper) {
		return false, ReasonErrorCIWide
	}
	if cfg.MaxErrorCIWidth > 0 && stats.ErrorRate.Width() > cfg.MaxErrorCIWidth {
		return false, ReasonErrorCIWide
	}
	return true, ""
}

// Verdict is the safety classification of one load level.
type Verdict int

const (
	// VerdictUnknown means evidence is insufficient to judge the level.
	VerdictUnknown Verdict = iota
	// VerdictSafe means every SLO bound holds at the configured confidence.
	VerdictSafe
	// VerdictUnsafe means at least one SLO bound is violated.
	VerdictUnsafe
)

// Verdict reasons returned by the evaluator.
const (
	ReasonInsufficientRequests = "insufficient_measured_requests"
	ReasonInsufficientWindows  = "insufficient_throughput_windows"
	ReasonThroughputCIWide     = "throughput_ci_too_wide"
	ReasonLatencyCIWide        = "latency_ci_too_wide"
	ReasonErrorCIWide          = "error_rate_ci_too_wide"

	ReasonLatencyBoundExceeded = "latency_quantile_bound_exceeded"
	ReasonErrorBoundExceeded   = "error_rate_bound_exceeded"
	ReasonSaturationKnee       = "saturation_throughput_gain_flat"
	ReasonSafe                 = "all_slo_bounds_hold"
)

// SLOConfig defines the service-level objective bounds. A bound is violated only
// when the confidence interval crosses it on the dangerous side, so uncertain
// levels never produce an aggressive step.
type SLOConfig struct {
	// MaxLatencyQuantileMS is the upper bound for the latency quantile CI.
	MaxLatencyQuantileMS float64
	// MaxErrorRate is the upper bound for the error-rate CI.
	MaxErrorRate float64
	// LatencyQuantile selects the quantile under test, e.g. 0.99 for p99.
	LatencyQuantile float64
	// SaturationGainFloor is the minimum relative throughput gain required
	// between consecutive levels: gain = (cur.Lower - prev.Upper) / prev.Upper.
	SaturationGainFloor float64
}

// LevelVerdict is the evaluated verdict for one level with its reason.
type LevelVerdict struct {
	Verdict Verdict
	Reason  string
	Stats   LevelStats
}

// EvaluateSafety applies the SLO bounds. It returns VerdictUnknown when the
// precision gate is not satisfied; otherwise it is conservative: the level is
// unsafe if a latency or error-rate confidence upper bound exceeds the SLO.
func EvaluateSafety(stats LevelStats, gate PrecisionGate, slo SLOConfig) LevelVerdict {
	if ok, reason := gate.Sufficient(stats); !ok {
		return LevelVerdict{Verdict: VerdictUnknown, Reason: reason, Stats: stats}
	}
	if stats.LatencyQuantile.Upper > slo.MaxLatencyQuantileMS {
		return LevelVerdict{Verdict: VerdictUnsafe, Reason: ReasonLatencyBoundExceeded, Stats: stats}
	}
	if stats.ErrorRate.Upper > slo.MaxErrorRate {
		return LevelVerdict{Verdict: VerdictUnsafe, Reason: ReasonErrorBoundExceeded, Stats: stats}
	}
	return LevelVerdict{Verdict: VerdictSafe, Reason: ReasonSafe, Stats: stats}
}

// IsSaturated reports the throughput saturation knee between the previous safe
// level and the current one. Saturation requires BOTH a statistically flat
// gain (the current throughput CI lower bound does not beat the previous upper
// bound by more than the gain floor) and overlapping confidence intervals,
// which together indicate the curve has bent over rather than merely wobbled.
func IsSaturated(previous, current LevelStats, gainFloor float64) bool {
	if previous.Throughput.N == 0 || current.Throughput.N == 0 {
		return false
	}
	prevUpper := previous.Throughput.Upper
	curLower := current.Throughput.Lower
	if math.IsNaN(prevUpper) || math.IsNaN(curLower) || prevUpper <= 0 {
		return false
	}
	gain := (curLower - prevUpper) / prevUpper
	overlap := current.Throughput.Lower <= previous.Throughput.Upper &&
		current.Throughput.Upper >= previous.Throughput.Lower
	return gain <= gainFloor && overlap
}
