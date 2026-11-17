package formal

// PolicyType selects how a ScalingPolicy value is interpreted.
type PolicyType string

const (
	// PodsPolicy allows an absolute number of pods to change per period.
	PodsPolicy PolicyType = "Pods"
	// PercentPolicy allows a percentage of the current replicas to change
	// per period (rounded up to whole pods).
	PercentPolicy PolicyType = "Percent"
)

// SelectPolicy chooses which policy limit wins when several are configured.
type SelectPolicy string

const (
	// MaxSelect allows the largest change of any policy (the default).
	MaxSelect SelectPolicy = "Max"
	// MinSelect allows the smallest change of any policy.
	MinSelect SelectPolicy = "Min"
	// DisabledSelect turns off scaling in this direction entirely.
	DisabledSelect SelectPolicy = "Disabled"
)

// ScalingPolicy bounds the replica change allowed within PeriodSeconds.
type ScalingPolicy struct {
	Type          PolicyType
	Value         int32
	PeriodSeconds int64
}

// ScalingRules groups the stabilization window and rate policies for one
// scaling direction.
type ScalingRules struct {
	// StabilizationWindowSeconds is how long past recommendations stay
	// eligible. Scale up picks the smallest recommendation in the window,
	// scale down picks the largest (most conservative) one.
	StabilizationWindowSeconds int64
	// SelectPolicy defaults to MaxSelect when empty.
	SelectPolicy SelectPolicy
	// Policies bound the change rate. Empty means unlimited.
	Policies []ScalingPolicy
}

// MetricSpec describes one metric the autoscaler averages across ready pods.
type MetricSpec struct {
	Name string
	// Target is the desired average value per ready pod; must be > 0.
	Target int64
}

// Config configures a Controller or Naive instance.
type Config struct {
	MinReplicas int32
	MaxReplicas int32
	Metrics     []MetricSpec
	ScaleUp     ScalingRules
	ScaleDown   ScalingRules
}

// Recommendation is the outcome of one evaluation.
type Recommendation struct {
	// Replicas is the final replica count after stabilization, rate
	// limiting and clamping to [MinReplicas, MaxReplicas].
	Replicas int32
	// Stabilized is the recommendation after the stabilization window but
	// before rate policies and clamping.
	Stabilized int32
	// Desired is the raw metric-based desire for this evaluation.
	Desired int32
	// Timestamp echoes the evaluation time.
	Timestamp int64
}
