package dataeng

import "fmt"

// Status is the outcome of a containment check.
type Status uint8

const (
	// Undecided means the step budget was exhausted before the search
	// completed. It never means "not contained".
	Undecided Status = iota
	// Contained means A is contained in B and Result.Mapping is complete.
	Contained
	// NotContained means a verified counterexample was produced.
	NotContained
)

func (s Status) String() string {
	switch s {
	case Contained:
		return "contained"
	case NotContained:
		return "not-contained"
	case Undecided:
		return "undecided"
	default:
		return fmt.Sprintf("status(%d)", s)
	}
}

// Binding maps one B variable to its target term in A.
type Binding struct {
	Variable string
	Target   Term
}

// Mapping is a complete mapping of every B variable. Entries are ordered by
// the variable's UTF-8 byte order. B constants are fixed and do not appear as
// bindings.
type Mapping []Binding

// Lookup returns the target of a mapped variable.
func (m Mapping) Lookup(variable string) (Term, bool) {
	for _, binding := range m {
		if binding.Variable == variable {
			return binding.Target, true
		}
	}
	return Term{}, false
}

// Clone returns a shallow copy (Terms contain immutable strings).
func (m Mapping) Clone() Mapping {
	return append(Mapping(nil), m...)
}

// Result is a containment decision, an undecided checkpoint, or a verified
// counterexample.
type Result struct {
	Status Status

	// Mapping is non-nil when Status is Contained. It contains one binding
	// for every B variable, in byte order. It maps B variables into A body
	// variables or constants from A or B.
	Mapping Mapping

	// Counterexample is non-nil when Status is NotContained. Its tuple has
	// been recomputed with the package interpreter: it belongs to A and does
	// not belong to B on Counterexample.Database.
	Counterexample *Counterexample

	// Steps is the number of candidate attempts consumed by this call.
	Steps int
	// TotalSteps is the number of candidate attempts consumed by this call
	// and all calls that produced the cursor.
	TotalSteps int

	// Cursor is non-nil exactly when Status is Undecided. Resume the same
	// input and cursor with a positive budget to continue.
	Cursor *Cursor
}

// Unlimited is a budget large enough for any practical bounded query search.
const Unlimited = int(^uint(0) >> 1)

// Check decides whether A is contained in B, using at most budget candidate
// attempts. A negative budget is an error. Exhausting the budget returns
// Undecided with a cursor and never returns NotContained.
//
// The search maps every B variable, in UTF-8 byte order, to constants from both
// queries first and then to variables occurring in A's body, each group in
// UTF-8 byte order. Constants are never substituted. The first successful
// mapping in that order is returned.
func Check(problem Problem, budget int) (Result, error) {
	if budget < 0 {
		return Result{}, fmt.Errorf("budget must be non-negative")
	}
	p, err := prepareProblem(problem)
	if err != nil {
		return Result{}, err
	}
	return advance(newCursor(p), budget)
}

// Resume continues an undecided search. The input must be identical to the
// input that produced cursor (compared by canonical encoding); otherwise an
// error is returned. The cursor itself owns a deep snapshot, so subsequent
// mutations of the caller's slices or schema cannot alter the search.
//
// Repeated Resume calls are equivalent to one Check call with a budget equal
// to the sum of the resume budgets.
func Resume(problem Problem, cursor *Cursor, budget int) (Result, error) {
	if budget < 0 {
		return Result{}, fmt.Errorf("budget must be non-negative")
	}
	if cursor == nil || cursor.problem == nil {
		return Result{}, fmt.Errorf("cursor is nil or uninitialized")
	}
	if cursor.done {
		return Result{}, fmt.Errorf("cursor is already decided")
	}
	p, err := prepareProblem(problem)
	if err != nil {
		return Result{}, err
	}
	if p.canonical != cursor.problem.canonical {
		return Result{}, fmt.Errorf("input does not match the cursor's original input")
	}
	return advance(cursor, budget)
}
