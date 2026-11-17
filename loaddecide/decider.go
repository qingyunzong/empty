package loaddecide

import (
	"errors"
	"fmt"
	"math"
)

// Status reports the terminal state of the search.
type Status int

const (
	// StatusRunning means more rounds are available and the search continues.
	StatusRunning Status = iota
	// StatusClosed means the knee is bracketed between a safe and an unsafe
	// (or saturated) level.
	StatusClosed
	// StatusCeiling means every level up to the configured safety ceiling is
	// safe; the ceiling is the highest admissible load.
	StatusCeiling
	// StatusExhausted means the measurement budget ran out before the knee
	// could be bracketed; the returned interval is intentionally unclosed.
	StatusExhausted
)

// String renders a human-readable status name.
func (s Status) String() string {
	switch s {
	case StatusRunning:
		return "running"
	case StatusClosed:
		return "closed"
	case StatusCeiling:
		return "ceiling"
	case StatusExhausted:
		return "exhausted"
	default:
		return "unknown"
	}
}

// Budget bounds the total measurement effort. A zero value disables that
// particular budget.
type Budget struct {
	// MaxRounds caps the number of judged load levels.
	MaxRounds int
	// MaxMeasuredRequests caps the total jitter-phase requests across levels.
	MaxMeasuredRequests int
}

// Config configures a Decider.
type Config struct {
	// Levels are the offered-load values (e.g. requests per second) in
	// ascending order.
	Levels []float64
	// MaxSafeLevelIndex is the safety ceiling: the decider never recommends a
	// level above it. Defaults to the highest index when negative.
	MaxSafeLevelIndex int
	// StartLevelIndex is the first level probed. Defaults to 0.
	StartLevelIndex int
	// Confidence is the per-interval confidence level. Defaults to 0.95.
	Confidence float64
	// SLO holds the service-objective bounds and saturation criterion.
	SLO SLOConfig
	// Precision gates every safety verdict.
	Precision PrecisionConfig
	// Budget limits total measurement effort.
	Budget Budget
}

// Bracket describes the current search interval on level indices. When
// HighOpen is true, no unsafe level has been found yet and HighLevel is a
// soft exclusive upper hint rather than a bound.
type Bracket struct {
	LowLevel  int
	HighLevel int
	HighOpen  bool
	Closed    bool
}

// KneeResult is the terminal outcome of the search.
type KneeResult struct {
	Status Status
	Reason string
	// HighestSafeIndex is the highest level proven safe, -1 when none.
	HighestSafeIndex int
	// BoundingUnsafeIndex is the first unsafe/saturated level, -1 when the
	// bracket is still open on the high side.
	BoundingUnsafeIndex int
	// Closed is false only when the budget was exhausted before bracketing.
	Closed bool
}

// Bracket returns the index-level knee bracket. An unclosed result reports
// HighOpen with BoundingUnsafeIndex == -1.
func (r KneeResult) Bracket() Bracket {
	high := r.BoundingUnsafeIndex
	return Bracket{
		LowLevel:  r.HighestSafeIndex,
		HighLevel: high,
		HighOpen:  high < 0,
		Closed:    r.Closed,
	}
}

// LoadInterval maps the bracket onto offered-load values. When the bracket is
// open on the high side, highLoad is NaN.
func (r KneeResult) LoadInterval(levels []float64) (lowLoad, highLoad float64) {
	low := levels[r.HighestSafeIndex]
	if r.BoundingUnsafeIndex < 0 {
		return low, math.NaN()
	}
	return low, levels[r.BoundingUnsafeIndex]
}

// Decider is the state machine driven by the load-test controller. It is safe
// for sequential single-goroutine use, matching the round-by-round controller
// loop.
type Decider struct {
	cfg        Config
	low        int
	high       int // -1 means open (no unsafe level observed yet)
	current    int
	collector  *Collector
	roundsUsed int
	requests   int
	status     Status
	reason     string
	result     *KneeResult

	lastSafeIndex int
	lastSafeStats LevelStats
	haveLastSafe  bool
}

// NewDecider validates the configuration and returns an idle decider.
func NewDecider(cfg Config) (*Decider, error) {
	if len(cfg.Levels) == 0 {
		return nil, errors.New("loaddecide: Config.Levels must not be empty")
	}
	for i := 1; i < len(cfg.Levels); i++ {
		if cfg.Levels[i] <= cfg.Levels[i-1] {
			return nil, errors.New("loaddecide: Config.Levels must be strictly ascending")
		}
	}
	ceiling := cfg.MaxSafeLevelIndex
	if ceiling < 0 {
		ceiling = len(cfg.Levels) - 1
	}
	if ceiling >= len(cfg.Levels) {
		return nil, errors.New("loaddecide: MaxSafeLevelIndex out of range")
	}
	start := cfg.StartLevelIndex
	if start < 0 {
		start = 0
	}
	if start > ceiling {
		return nil, errors.New("loaddecide: StartLevelIndex above safety ceiling")
	}
	confidence := cfg.Confidence
	if confidence == 0 {
		confidence = 0.95
	}
	if confidence <= 0 || confidence >= 1 {
		return nil, errors.New("loaddecide: Confidence must be inside (0,1)")
	}
	slo := cfg.SLO
	if slo.LatencyQuantile <= 0 || slo.LatencyQuantile >= 1 {
		return nil, errors.New("loaddecide: SLO.LatencyQuantile must be inside (0,1)")
	}
	if slo.MaxLatencyQuantileMS <= 0 {
		return nil, errors.New("loaddecide: SLO.MaxLatencyQuantileMS must be positive")
	}
	if slo.MaxErrorRate <= 0 || slo.MaxErrorRate > 1 {
		return nil, errors.New("loaddecide: SLO.MaxErrorRate must be inside (0,1]")
	}
	if slo.SaturationGainFloor == 0 {
		slo.SaturationGainFloor = 0.05
	}
	cfg.SLO = slo
	cfg.Confidence = confidence
	cfg.MaxSafeLevelIndex = ceiling
	cfg.StartLevelIndex = start

	return &Decider{
		cfg:           cfg,
		low:           start,
		high:          -1,
		current:       start,
		lastSafeIndex: -1,
	}, nil
}

// NextLevel returns the load level to apply and whether the search is still
// active. The first call starts the first round; later calls return the same
// level while its measurement is in progress. A false ok means the search has
// terminated.
func (d *Decider) NextLevel() (load float64, index int, ok bool) {
	if d.status != StatusRunning {
		return 0, -1, false
	}
	if d.collector == nil {
		d.collector = NewCollector(d.cfg.Confidence)
	}
	return d.cfg.Levels[d.current], d.current, true
}

// AddWarmup feeds a warmup observation for the current level.
func (d *Decider) AddWarmup(obs Observation) error {
	if d.collector == nil {
		return errors.New("loaddecide: call NextLevel before adding observations")
	}
	return d.collector.AddWarmup(obs)
}

// AddMeasured feeds a jitter-phase observation for the current level and
// accounts it against the request budget.
func (d *Decider) AddMeasured(obs Observation) error {
	if d.collector == nil {
		return errors.New("loaddecide: call NextLevel before adding observations")
	}
	d.collector.AddMeasured(obs)
	d.requests++
	return nil
}

// AddWindow feeds a completed throughput window for the current level.
func (d *Decider) AddWindow(window ThroughputWindow) error {
	if d.collector == nil {
		return errors.New("loaddecide: call NextLevel before adding windows")
	}
	d.collector.AddWindow(window)
	return nil
}

// RoundsUsed reports how many levels have received a final verdict.
func (d *Decider) RoundsUsed() int { return d.roundsUsed }

// MeasuredRequests reports total jitter-phase requests consumed so far.
func (d *Decider) MeasuredRequests() int { return d.requests }

// Status reports the current search status.
func (d *Decider) Status() Status { return d.status }

// Bracket returns the current index-level bracket.
func (d *Decider) Bracket() Bracket {
	return Bracket{
		LowLevel:  d.low,
		HighLevel: d.high,
		HighOpen:  d.high < 0,
		Closed:    d.high >= 0,
	}
}

// Result returns the terminal result, or nil while the search is running.
func (d *Decider) Result() *KneeResult { return d.result }

// Evaluate judges the current level from the samples collected so far. An
// unknown verdict means the controller should keep measuring the same level;
// a safe or unsafe verdict advances the search and arms the next level.
func (d *Decider) Evaluate() (LevelVerdict, error) {
	if d.status != StatusRunning {
		return LevelVerdict{}, fmt.Errorf("loaddecide: search already terminated (%s)", d.status)
	}
	if d.collector == nil || d.collector.MeasuredRequests() == 0 {
		return LevelVerdict{}, ErrEmptyCollector
	}
	stats, err := d.collector.Snapshot(d.current, d.cfg.SLO.LatencyQuantile)
	if err != nil {
		return LevelVerdict{}, err
	}
	verdict := EvaluateSafety(stats, PrecisionGate{Config: d.cfg.Precision}, d.cfg.SLO)
	if verdict.Verdict == VerdictUnknown {
		if d.budgetExhausted() {
			d.finalize(StatusExhausted, verdict.Reason)
		}
		return verdict, nil
	}

	d.roundsUsed++
	switch verdict.Verdict {
	case VerdictUnsafe:
		d.high = d.current
		d.finalize(StatusClosed, verdict.Reason)
		return verdict, nil
	case VerdictSafe:
		if d.haveLastSafe && d.lastSafeIndex == d.current-1 &&
			IsSaturated(d.lastSafeStats, stats, d.cfg.SLO.SaturationGainFloor) {
			d.high = d.current
			d.finalize(StatusClosed, ReasonSaturationKnee)
			return LevelVerdict{Verdict: VerdictUnsafe, Reason: ReasonSaturationKnee, Stats: stats}, nil
		}
		if d.current > d.low {
			d.low = d.current
		}
		d.lastSafeIndex = d.current
		d.lastSafeStats = stats
		d.haveLastSafe = true

		if d.current >= d.cfg.MaxSafeLevelIndex {
			d.high = d.current
			d.finalize(StatusCeiling, ReasonSafe)
			return verdict, nil
		}
		if d.budgetExhausted() {
			d.finalize(StatusExhausted, verdict.Reason)
			return verdict, nil
		}
		d.advanceTo(d.current + 1)
	}
	return verdict, nil
}

func (d *Decider) budgetExhausted() bool {
	if d.cfg.Budget.MaxRounds > 0 && d.roundsUsed >= d.cfg.Budget.MaxRounds {
		return true
	}
	if d.cfg.Budget.MaxMeasuredRequests > 0 && d.requests >= d.cfg.Budget.MaxMeasuredRequests {
		return true
	}
	return false
}

func (d *Decider) advanceTo(index int) {
	// The ceiling guard makes overshoot impossible even if callers extend the
	// level list later.
	if index > d.cfg.MaxSafeLevelIndex {
		index = d.cfg.MaxSafeLevelIndex
	}
	d.current = index
	d.collector = NewCollector(d.cfg.Confidence)
}

func (d *Decider) finalize(status Status, reason string) {
	d.status = status
	d.reason = reason
	high := d.high
	d.result = &KneeResult{
		Status:              status,
		Reason:              reason,
		HighestSafeIndex:    d.low,
		BoundingUnsafeIndex: high,
		Closed:              high >= 0,
	}
}

// TerminationReason returns the reason recorded when the search terminated.
func (d *Decider) TerminationReason() string { return d.reason }
