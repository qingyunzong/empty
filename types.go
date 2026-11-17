package formal

import (
	"errors"
	"fmt"
	"math"
)

// Arm identifies one side of an A/B comparison.
type Arm string

const (
	// Control is the unchanged baseline.
	Control Arm = "control"
	// Treatment is the canary/experiment arm.
	Treatment Arm = "treatment"
	// Experiment is an alias for Treatment.
	Experiment Arm = Treatment
)

// Valid reports whether the arm is known.
func (a Arm) Valid() bool {
	return a == Control || a == Treatment
}

// MetricKind selects the sampling model used by the sequential test.
type MetricKind string

const (
	// KindProportion is a 0/1 metric such as success rate or error rate.
	KindProportion MetricKind = "proportion"
	// KindContinuous is a real-valued metric such as latency or throughput.
	KindContinuous MetricKind = "continuous"
)

// MetricDirection states which movement of the metric is desirable.
type MetricDirection string

const (
	// HigherIsBetter means the treatment improves when its mean is higher.
	HigherIsBetter MetricDirection = "higher_is_better"
	// LowerIsBetter means the treatment improves when its mean is lower.
	LowerIsBetter MetricDirection = "lower_is_better"
)

// Action is the traffic decision returned to the progressive delivery loop.
type Action string

const (
	// Hold keeps the treatment at its current traffic percentage.
	Hold Action = "hold"
	// ScaleUp moves the treatment to the next configured traffic step.
	ScaleUp Action = "scale_up"
	// Rollback removes treatment traffic. Once executed it is irreversible.
	Rollback Action = "rollback"
)

var (
	// ErrUnknownMetric is returned when an observation names an unconfigured metric.
	ErrUnknownMetric = errors.New("formal: unknown metric")
	// ErrInvalidArm is returned for an arm other than control/treatment.
	ErrInvalidArm = errors.New("formal: invalid arm")
	// ErrInvalidValue is returned for NaN, infinity, or an invalid 0/1 value.
	ErrInvalidValue = errors.New("formal: invalid metric value")
	// ErrRollbackLocked is returned when a caller tries to scale after an
	// executed rollback.
	ErrRollbackLocked = errors.New("formal: rollback already executed and cannot be undone")
	// ErrInvalidAction is returned for an unknown decision action.
	ErrInvalidAction = errors.New("formal: invalid action")
)

// Observation is one SLI sample. ID is optional. When it is non-empty, a later
// observation with the same metric and ID replaces the earlier value. That is
// how delayed or corrected data is backfilled without double counting.
type Observation struct {
	Metric string  `json:"metric"`
	Arm    Arm     `json:"arm"`
	Value  float64 `json:"value"`
	ID     string  `json:"id,omitempty"`
}

// MetricSpec declares one SLI and its sequential-test plan.
type MetricSpec struct {
	// Name is the stable identifier used by observations.
	Name string `json:"name"`
	// Kind selects a proportion or continuous sampling model.
	Kind MetricKind `json:"kind"`
	// Direction defines whether an increase or a decrease is an improvement.
	Direction MetricDirection `json:"direction"`
	// MinSamplesPerArm is the minimum number of samples required before this
	// metric can produce any decision. Zero falls back to Config.MinSamplesPerArm.
	MinSamplesPerArm int `json:"min_samples_per_arm,omitempty"`
	// MaxSamplesPerArm is an optional planned maximum. When every metric has
	// reached its maximum, Decision.Final is set.
	MaxSamplesPerArm int `json:"max_samples_per_arm,omitempty"`
	// Weight controls this metric's share of the overall alpha budget. A zero
	// weight means one; weights are normalized across metrics.
	Weight float64 `json:"weight,omitempty"`
}

// Config is the immutable experiment plan.
type Config struct {
	// Alpha is the total family-wise false-alarm budget across all metrics and
	// all sequential looks. A typical value is 0.05.
	Alpha float64 `json:"alpha"`
	// Metrics must contain unique names and at least one entry.
	Metrics []MetricSpec `json:"metrics"`
	// MinSamplesPerArm is the fallback minimum for metrics that do not set one.
	MinSamplesPerArm int `json:"min_samples_per_arm,omitempty"`
	// TrafficSteps is the ordered treatment traffic schedule in percent. The
	// first entry is the initial traffic. Nil selects 1,5,10,25,50,100.
	TrafficSteps []float64 `json:"traffic_steps,omitempty"`
}

// MetricResult is the statistics and verdict for one metric at one look.
type MetricResult struct {
	Name          string          `json:"name"`
	Kind          MetricKind      `json:"kind"`
	Direction     MetricDirection `json:"direction"`
	ControlN      int             `json:"control_n"`
	TreatmentN    int             `json:"treatment_n"`
	ControlMean   float64         `json:"control_mean"`
	TreatmentMean float64         `json:"treatment_mean"`
	Difference    float64         `json:"difference"` // treatment - control
	ZScore        float64         `json:"z_score"`
	Look          int             `json:"look"`
	LookAlpha     float64         `json:"look_alpha"`
	CriticalValue float64         `json:"critical_value"`
	Ready         bool            `json:"ready"`
	Significant   bool            `json:"significant"`
	Improved      bool            `json:"improved"`
	Regressed     bool            `json:"regressed"`
	AtMaxSamples  bool            `json:"at_max_samples"`
}

// Decision is the result of one sequential look. Evaluate only recommends an
// action; Execute records that the orchestrator actually performed it.
type Decision struct {
	Action             Action         `json:"action"`
	Reason             string         `json:"reason"`
	Look               int            `json:"look"`
	Locked             bool           `json:"locked"`
	Final              bool           `json:"final"`
	RollbackExecuted   bool           `json:"rollback_executed"`
	TrafficPercent     float64        `json:"traffic_percent"`
	NextTrafficPercent float64        `json:"next_traffic_percent"`
	PendingMetrics     []string       `json:"pending_metrics,omitempty"`
	HelpfulMetrics     []string       `json:"helpful_metrics,omitempty"`
	HarmfulMetrics     []string       `json:"harmful_metrics,omitempty"`
	Metrics            []MetricResult `json:"metrics"`
}

// Validate checks a configuration without constructing an Engine.
func (c Config) Validate() error {
	if math.IsNaN(c.Alpha) || math.IsInf(c.Alpha, 0) || c.Alpha <= 0 || c.Alpha >= 1 {
		return fmt.Errorf("formal: alpha must be in (0,1), got %v", c.Alpha)
	}
	if len(c.Metrics) == 0 {
		return errors.New("formal: at least one metric is required")
	}
	seen := make(map[string]struct{}, len(c.Metrics))
	for i, m := range c.Metrics {
		if m.Name == "" {
			return fmt.Errorf("formal: metric %d has an empty name", i)
		}
		if _, ok := seen[m.Name]; ok {
			return fmt.Errorf("formal: duplicate metric %q", m.Name)
		}
		seen[m.Name] = struct{}{}
		if m.Kind != KindProportion && m.Kind != KindContinuous {
			return fmt.Errorf("formal: metric %q has invalid kind %q", m.Name, m.Kind)
		}
		if m.Direction != HigherIsBetter && m.Direction != LowerIsBetter {
			return fmt.Errorf("formal: metric %q has invalid direction %q", m.Name, m.Direction)
		}
		min := m.MinSamplesPerArm
		if min == 0 {
			min = c.MinSamplesPerArm
		}
		if min == 0 {
			min = defaultMinSamples
		}
		if min < 2 {
			return fmt.Errorf("formal: metric %q needs at least 2 samples per arm, got %d", m.Name, min)
		}
		if m.MaxSamplesPerArm != 0 && m.MaxSamplesPerArm < min {
			return fmt.Errorf("formal: metric %q max samples %d is below min samples %d", m.Name, m.MaxSamplesPerArm, min)
		}
		if math.IsNaN(m.Weight) || math.IsInf(m.Weight, 0) || m.Weight < 0 {
			return fmt.Errorf("formal: metric %q has invalid weight %v", m.Name, m.Weight)
		}
	}
	if err := validateTrafficSteps(c.TrafficSteps); err != nil {
		return err
	}
	return nil
}

func validateTrafficSteps(steps []float64) error {
	if len(steps) == 0 {
		return nil
	}
	prev := 0.0
	for i, s := range steps {
		if math.IsNaN(s) || math.IsInf(s, 0) || s <= 0 || s > 100 {
			return fmt.Errorf("formal: traffic step %d must be in (0,100], got %v", i, s)
		}
		if i > 0 && s <= prev {
			return fmt.Errorf("formal: traffic steps must be strictly increasing at index %d", i)
		}
		prev = s
	}
	return nil
}
