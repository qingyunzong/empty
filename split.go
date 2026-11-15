package dataeng

// Split computes a grouped temporal train/validation/test partition.
//
// Hard constraints:
//   - every connected entity/group component is assigned to exactly one split;
//   - every test timestamp is strictly later than every train timestamp
//     (disabled when all timestamps are zero);
//   - all three splits are non-empty unless Config.AllowEmptySplits is set.
//
// Among feasible plans it minimizes the configured class-proportion deviation.
// Exact ties are resolved by the lexicographically smallest assignment vector,
// where blocks are ordered by their stable key and splits by Train, Validation,
// Test. The search returns StatusOptimal when it closes the proof, or
// StatusBudgetExhausted with the best incumbent and an open-frontier proof when
// a node or time budget stops it.
func Split(records []Record, cfg Config) (Result, error) {
	p, err := prepare(records, cfg)
	if err != nil {
		return Result{}, err
	}
	s := newSolver(p, resolveNodeBudget(cfg), cfg.MaxDuration)
	s.search()
	return s.result(), nil
}

// SplitRecords is an alias for Split.
func SplitRecords(records []Record, cfg Config) (Result, error) {
	return Split(records, cfg)
}

// Optimize is an alias for Split.
func Optimize(records []Record, cfg Config) (Result, error) {
	return Split(records, cfg)
}

// Planner binds a configuration for repeated requests in a serving process.
// It is safe for concurrent use.
type Planner struct {
	Config Config
}

// NewPlanner returns a reusable splitter.
func NewPlanner(cfg Config) *Planner {
	return &Planner{Config: cfg}
}

// Split runs the planner's configuration.
func (p *Planner) Split(records []Record) (Result, error) {
	if p == nil {
		return Split(records, Config{})
	}
	return Split(records, p.Config)
}

func resolveNodeBudget(cfg Config) int {
	chosen := 0
	unlimited := false
	for _, value := range [...]int{cfg.MaxNodes, cfg.MaxSteps} {
		switch {
		case value == 0:
			continue
		case value < 0:
			unlimited = true
		case chosen == 0 || value < chosen:
			chosen = value
		}
	}
	if chosen > 0 {
		return chosen
	}
	if unlimited {
		return Unlimited
	}
	return DefaultMaxNodes
}
