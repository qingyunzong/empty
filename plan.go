package planexec

import "fmt"

// Step is one unit of a plan.
//
//	Pre   precondition checked before Do; a failure aborts the batch.
//	Do    the forward action.
//	Image post-image check run before Undo during rollback; a mismatch means
//	      the state was modified externally and must not be force-overwritten.
//	Undo  inverse action of Do.
//
// Any field may be nil: nil Pre/Image always pass, nil Do/Undo are no-ops.
type Step struct {
	Name  string
	Pre   func(Store) error
	Do    func(Store) error
	Image func(Store) error
	Undo  func(Store) error
}

// Conflict records a step whose post-image no longer matches the store,
// i.e. an unknown external modification that was left untouched.
type Conflict struct {
	Step   string
	Detail string
}

// Result reports the outcome of Execute.
type Result struct {
	// Applied lists steps whose Do succeeded, in execution order.
	Applied []string
	// FailedStep is the index of the step that aborted the batch, or -1.
	FailedStep int
	// Err is the batch-level failure (precondition or action), if any.
	Err error
	// RolledBack lists steps successfully undone, newest first.
	RolledBack []string
	// RollbackErr is the first inverse-action failure, if any.
	RollbackErr error
	// Conflicts lists steps skipped during rollback because their
	// post-image no longer matched (external modification).
	Conflicts []Conflict
	// Pending is the unrecovered tail: steps still applied (or in an
	// unknown state) after rollback stopped, oldest first.
	Pending []string
}

// OK reports whether the batch fully succeeded.
func (r *Result) OK() bool { return r.Err == nil && r.FailedStep < 0 }

// Recovered reports whether nothing is left applied or unknown.
func (r *Result) Recovered() bool { return len(r.Pending) == 0 }

// Execute runs steps in order. On the first precondition or action failure
// it rolls back already-applied steps in reverse order. During rollback a
// post-image mismatch is treated as an unknown external modification: the
// step is not force-overwritten, a Conflict is recorded, and rollback stops
// with the remaining tail in Pending. A failing inverse action likewise
// stops rollback and leaves the unrecovered tail in Pending.
func Execute(s Store, steps []Step) *Result {
	r := &Result{FailedStep: -1}
	var applied []Step
	for i, st := range steps {
		if st.Pre != nil {
			if err := st.Pre(s); err != nil {
				r.FailedStep = i
				r.Err = fmt.Errorf("step %q precondition: %w", st.Name, err)
				break
			}
		}
		if st.Do != nil {
			if err := st.Do(s); err != nil {
				r.FailedStep = i
				r.Err = fmt.Errorf("step %q action: %w", st.Name, err)
				break
			}
		}
		applied = append(applied, st)
		r.Applied = append(r.Applied, st.Name)
	}
	if r.Err == nil {
		return r
	}
	for j := len(applied) - 1; j >= 0; j-- {
		st := applied[j]
		if st.Image != nil {
			if err := st.Image(s); err != nil {
				r.Conflicts = append(r.Conflicts, Conflict{Step: st.Name, Detail: err.Error()})
				r.Pending = names(applied[: j+1 : j+1])
				return r
			}
		}
		if st.Undo != nil {
			if err := st.Undo(s); err != nil {
				r.RollbackErr = fmt.Errorf("step %q inverse: %w", st.Name, err)
				r.Pending = names(applied[: j+1 : j+1])
				return r
			}
		}
		r.RolledBack = append(r.RolledBack, st.Name)
	}
	return r
}

func names(steps []Step) []string {
	out := make([]string, len(steps))
	for i, st := range steps {
		out[i] = st.Name
	}
	return out
}
