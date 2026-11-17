package formal

import (
	"errors"
	"fmt"
)

// MaxBruteForceJobs bounds the exhaustive verifier's job count. Enumeration
// is O(2^n), so it is meant for small clusters in tests and audits.
const MaxBruteForceJobs = 24

var ErrTooManyJobs = errors.New("quota: too many jobs for exhaustive verification")

// BruteForce enumerates every feasible allocation (capacity-respecting,
// gang-atomic by construction) and returns the one with the best Score,
// breaking ties in canonical fairness order. Because the tie-break is a
// total order, the optimum is unique, so an exact planner must reproduce
// this plan precisely.
func BruteForce(in Input) (*Result, error) {
	p, err := prepare(in)
	if err != nil {
		return nil, err
	}
	n := len(p.jobs)
	if n > MaxBruteForceJobs {
		return nil, ErrTooManyJobs
	}
	best := make([]bool, n)
	var bestScore Score
	first := true
	taken := make([]bool, n)
	var enumerate func(i int, capLeft int64)
	enumerate = func(i int, capLeft int64) {
		if i == n {
			s := p.scoreOf(taken)
			if first || better(taken, s, best, bestScore) {
				first = false
				bestScore = s
				copy(best, taken)
			}
			return
		}
		enumerate(i+1, capLeft)
		if p.units[i] <= capLeft {
			taken[i] = true
			enumerate(i+1, capLeft-p.units[i])
			taken[i] = false
		}
	}
	enumerate(0, p.capLeft)
	return p.assemble(best), nil
}

// better reports whether candidate (taken, s) beats (best, bs): higher score,
// or equal score and lexicographically earlier in canonical fairness order
// (the candidate includes some earlier-ranked job that best skips).
func better(taken []bool, s Score, best []bool, bs Score) bool {
	switch s.Compare(bs) {
	case 1:
		return true
	case -1:
		return false
	}
	for i := range taken {
		if taken[i] != best[i] {
			return taken[i]
		}
	}
	return false
}

// Verify checks that plan is a feasible, gang-atomic, optimal answer for in
// by comparing it against the exhaustive optimum. It reports the first
// discrepancy found: infeasibility, suboptimal score, or a different
// tie-break.
func Verify(in Input, plan *Result) error {
	opt, err := BruteForce(in)
	if err != nil {
		return err
	}
	if err := checkFeasible(in, plan); err != nil {
		return err
	}
	if plan.Score.Compare(opt.Score) != 0 {
		return fmt.Errorf("quota: plan score %+v is not optimal %+v", plan.Score, opt.Score)
	}
	got := map[string]bool{}
	for _, j := range plan.Allocated {
		got[j.ID] = true
	}
	for _, j := range opt.Allocated {
		if !got[j.ID] {
			return fmt.Errorf("quota: optimal plan allocates %q but verified plan does not", j.ID)
		}
	}
	if len(got) != len(opt.Allocated) {
		for id := range got {
			found := false
			for _, j := range opt.Allocated {
				if j.ID == id {
					found = true
					break
				}
			}
			if !found {
				return fmt.Errorf("quota: verified plan allocates %q but optimal plan does not", id)
			}
		}
	}
	return nil
}

// checkFeasible validates capacity, gang atomicity, and non-preemptible
// retention without reference to optimality.
func checkFeasible(in Input, plan *Result) error {
	var used int64
	seen := map[string]bool{}
	for _, j := range plan.Allocated {
		if seen[j.ID] {
			return fmt.Errorf("quota: job %q allocated twice", j.ID)
		}
		seen[j.ID] = true
		used += j.Units()
	}
	if used > in.Capacity {
		return fmt.Errorf("quota: allocation uses %d of %d units", used, in.Capacity)
	}
	for _, j := range in.Jobs {
		if j.Running && !j.Preemptible && !seen[j.ID] {
			return fmt.Errorf("quota: non-preemptible job %q was dropped", j.ID)
		}
	}
	return nil
}
