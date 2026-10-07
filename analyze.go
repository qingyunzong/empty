package matchcheck

import "sort"

// Branch is a single match arm. Guard marks arms with a guard condition;
// guards are never assumed to hold, so a guarded arm does not contribute
// to coverage.
type Branch struct {
	Pattern *Pattern
	Guard   bool
}

// Options configures Analyze.
type Options struct {
	// Budget caps how many values of the scrutinee type are enumerated
	// for exact checking. Types with more values, or involving Unknown,
	// fall back to structural (catch-all) analysis. Defaults to 4096.
	Budget int
	// MaxUncovered caps the number of uncovered witness values reported.
	// Defaults to 8.
	MaxUncovered int
}

const (
	defaultBudget       = 4096
	defaultMaxUncovered = 8
)

// Report is the outcome of Analyze.
type Report struct {
	// Exhaustive is true when every value is covered by some unguarded
	// branch. For enumerated types this is exact; otherwise it means an
	// unguarded catch-all branch exists.
	Exhaustive bool
	// Enumerated is true when the value space was fully enumerated
	// (small finite type within budget). It is false for types
	// involving Unknown or exceeding the budget, where exhaustiveness
	// rests only on the presence of a catch-all branch.
	Enumerated bool
	// Unreachable lists indices of branches that can never match: their
	// pattern only covers values already handled by earlier unguarded
	// branches (or they follow a catch-all).
	Unreachable []int
	// Uncovered holds the minimal uncovered values (declaration order,
	// tuples lexicographic), capped by MaxUncovered. Empty when the
	// value space could not be enumerated.
	Uncovered []Value
}

// Analyze checks branches (in order) against the scrutinee type.
func Analyze(scrutinee *Type, branches []Branch, opts Options) *Report {
	budget := opts.Budget
	if budget <= 0 {
		budget = defaultBudget
	}
	maxUncovered := opts.MaxUncovered
	if maxUncovered <= 0 {
		maxUncovered = defaultMaxUncovered
	}
	if values, ok := scrutinee.enumerate(budget); ok {
		return analyzeEnumerated(scrutinee, branches, values, maxUncovered)
	}
	return analyzeStructural(scrutinee, branches)
}

func analyzeEnumerated(t *Type, branches []Branch, values []Value, maxUncovered int) *Report {
	remaining := make(map[string]Value, len(values))
	for _, v := range values {
		remaining[v.String()] = v
	}
	rep := &Report{Enumerated: true}
	for i, b := range branches {
		useful := false
		for key, v := range remaining {
			if matches(t, b.Pattern, v) {
				useful = true
				if !b.Guard {
					delete(remaining, key)
				}
			}
		}
		if !useful {
			rep.Unreachable = append(rep.Unreachable, i)
		}
	}
	rep.Exhaustive = len(remaining) == 0
	uncovered := make([]Value, 0, len(remaining))
	for _, v := range remaining {
		uncovered = append(uncovered, v)
	}
	sort.Slice(uncovered, func(i, j int) bool {
		return t.compare(uncovered[i], uncovered[j]) < 0
	})
	if len(uncovered) > maxUncovered {
		uncovered = uncovered[:maxUncovered]
	}
	rep.Uncovered = uncovered
	return rep
}

func analyzeStructural(t *Type, branches []Branch) *Report {
	rep := &Report{}
	for i, b := range branches {
		if !b.Guard && catchAll(t, b.Pattern) {
			for j := i + 1; j < len(branches); j++ {
				rep.Unreachable = append(rep.Unreachable, j)
			}
			rep.Exhaustive = true
			return rep
		}
	}
	return rep
}
