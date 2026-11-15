package dataeng

import (
	"math"
	"time"
)

// SplitName identifies one of the three output partitions.
type SplitName string

const (
	Train      SplitName = "train"
	Validation SplitName = "validation"
	Test       SplitName = "test"
)

// SplitOrder is the canonical order used both for deterministic tie-breaking
// and for the choice order in the optimizer.
var SplitOrder = [...]SplitName{Train, Validation, Test}

// Metric selects the objective minimized by the splitter.
//
// Every metric is evaluated on proportions of the total record weight, not on
// raw counts, so the result is independent of the corpus size.
type Metric string

const (
	// L1 minimizes the sum of absolute cell deviations. It is the default.
	L1 Metric = "l1"
	// L2 minimizes the sum of squared cell deviations.
	L2 Metric = "l2"
	// Linf minimizes the largest absolute cell deviation.
	Linf Metric = "linf"
)

// Record is one input row.
//
// Entity and groups define the leakage units. All records connected through a
// shared entity or a shared group (directly or transitively) form one
// indivisible block. Group is a shorthand for a single entry in Groups.
//
// Weight is the record's contribution to class proportions. A zero Weight is
// interpreted as 1. Time is used for the "test is later than train" hard
// constraint. If every record has a zero Time, the time constraint is disabled.
// An empty ID is replaced by a stable synthetic ID.
type Record struct {
	ID     string
	Entity string
	Group  string
	Groups []string
	Time   time.Time
	Class  string
	Weight float64
}

// Sample is a compatibility alias for Record.
type Sample = Record

// Target is the desired mass of every (split, class) cell as a fraction of the
// whole corpus. Values are non-negative relative weights: BuildTarget and the
// splitter normalize the complete matrix to sum to one. A missing cell means
// zero target mass.
type Target map[SplitName]map[string]float64

// TargetMode defines how Config.Target values are interpreted.
type TargetMode string

const (
	// TargetMass treats each target cell as a share of the whole corpus. This
	// is the default and is what BuildTarget returns.
	TargetMass TargetMode = "mass"
	// TargetConditional treats each split row as a class distribution inside
	// that split. Config.SplitShares (or the 0.8/0.1/0.1 default) supplies the
	// split sizes.
	TargetConditional TargetMode = "conditional"
)

// Config controls the splitter.
//
// If Target is non-empty it is used directly, interpreted according to
// TargetMode. Otherwise the target is the product of SplitShares and
// ClassShares. Missing SplitShares default to 0.8/0.1/0.1, and missing
// ClassShares default to the empirical class distribution. Share maps are
// normalized independently.
type Config struct {
	Target      Target
	TargetMode  TargetMode
	SplitShares map[SplitName]float64
	ClassShares map[string]float64

	Metric Metric

	// MaxNodes and MaxSteps are aliases for the search-node budget. When both
	// are positive the smaller value is used. Zero selects DefaultMaxNodes;
	// either value may be set to Unlimited (-1) to disable the node budget.
	MaxNodes int
	MaxSteps int

	// MaxDuration limits wall-clock search time. Zero means no time limit.
	// The node budget is the reproducible option; MaxDuration is useful in a
	// serving path where latency matters more than reproducibility.
	MaxDuration time.Duration

	// AllowEmptySplits permits a partition to contain no records. By default
	// all three partitions must be non-empty.
	AllowEmptySplits bool

	// Epsilon overrides floating-point comparison tolerance. A zero value uses
	// a small absolute default (1e-12).
	Epsilon float64
}

// DefaultMaxNodes is the default branch-and-bound budget.
const DefaultMaxNodes = 1000000

// Unlimited disables a budget when used as MaxNodes or MaxSteps.
const Unlimited = -1

// Status describes how the search ended.
type Status string

const (
	// StatusOptimal means the returned incumbent is proven optimal, including
	// the stable lexicographic tie-break.
	StatusOptimal Status = "optimal"
	// StatusBudgetExhausted means a valid incumbent (if Feasible) was returned,
	// but the open frontier still has a lower bound below or equal to it.
	StatusBudgetExhausted Status = "budget_exhausted"
	// StatusInfeasible means the complete search proved that no assignment can
	// satisfy the hard constraints.
	StatusInfeasible Status = "infeasible"
)

// GroupBlock is an indivisible leakage unit discovered from entity/group links.
type GroupBlock struct {
	Key          string
	EntityIDs    []string
	GroupIDs     []string
	RecordIDs    []string
	Earliest     time.Time
	Latest       time.Time
	ClassWeights map[string]float64
	Weight       float64
	Split        SplitName
}

// SplitTime summarizes the time span and record count of an output partition.
type SplitTime struct {
	Earliest time.Time
	Latest   time.Time
	Count    int
}

// Choice records the assignment of one leakage block in an open subproblem.
type Choice struct {
	BlockKey string    `json:"block_key"`
	Split    SplitName `json:"split"`
}

// OpenSubproblem is one node of the unclosed branch-and-bound frontier. Its
// LowerBound is a valid lower bound for every completion of the recorded
// prefix.
type OpenSubproblem struct {
	Depth        int      `json:"depth"`
	NextBlockKey string   `json:"next_block_key,omitempty"`
	LowerBound   float64  `json:"lower_bound"`
	Prefix       []Choice `json:"prefix,omitempty"`
}

// Proof describes why the search stopped. Complete is true only when the
// returned status is proven optimal or proven infeasible. When a node or time
// budget stops the search, Open lists a deterministic sample of the frontier
// and OpenCount is its full size.
type Proof struct {
	Complete   bool             `json:"complete"`
	Reason     string           `json:"reason"`
	LowerBound float64          `json:"lower_bound"`
	UpperBound float64          `json:"upper_bound"`
	Gap        float64          `json:"gap"`
	OpenCount  int              `json:"open_count"`
	Open       []OpenSubproblem `json:"open,omitempty"`
}

// Result is a complete split plan and the optimization certificate.
type Result struct {
	Status   Status
	Feasible bool

	// Objective is the deviation of the returned plan. UpperBound has the same
	// value; it is named explicitly to pair with LowerBound.
	Objective  float64
	LowerBound float64
	UpperBound float64
	Gap        float64

	// Assignments maps every record ID to its output partition.
	Assignments map[string]SplitName
	// Splits contains record IDs in stable order for each partition.
	Splits map[SplitName][]string
	// Indices contains the corresponding input indices.
	Indices map[SplitName][]int

	// Counts contains weighted class totals. Proportions contains the same
	// values divided by the total corpus weight.
	Counts      map[SplitName]map[string]float64
	Proportions map[SplitName]map[string]float64
	Targets     Target

	TimeBounds map[SplitName]SplitTime
	Blocks     []GroupBlock

	Steps int
	Proof Proof
}

func infinite() float64 { return math.Inf(1) }
