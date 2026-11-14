package dataeng

import "fmt"

// Solver is a reusable, concurrency-safe page-order adjudicator. It only
// stores normalized options; all per-batch state is local to a call.
type Solver struct {
	opts Options
}

// NewSolver validates opts and returns a solver. The zero Options value is
// valid and selects the documented defaults.
func NewSolver(opts Options) (*Solver, error) {
	normalized, err := normalizeOptions(opts)
	if err != nil {
		return nil, err
	}
	return &Solver{opts: normalized}, nil
}

func (s *Solver) options() (Options, error) {
	if s == nil {
		return normalizeOptions(Options{})
	}
	return normalizeOptions(s.opts)
}

// Solve chooses the exact solver for small batches and beam search for
// larger ones. Check Result.Exhaustive to see which guarantee applies.
func (s *Solver) Solve(doc Document) (Result, error) {
	opts, err := s.options()
	if err != nil {
		return Result{}, err
	}
	m, err := newModel(doc, opts)
	if err != nil {
		return Result{}, err
	}
	n := len(m.pages)
	if n <= opts.ExactMaxPages && n <= maxExactPages {
		states := (1 << uint(n)) * (n + 1) * m.cMax
		if states <= maxExactState {
			return m.solveExact()
		}
	}
	return m.solveBeam()
}

// SolveExact runs exhaustive subset dynamic programming. It returns
// ErrTooManyPages when the batch exceeds the exact state-space budget.
// The first result is a provable global optimum.
func (s *Solver) SolveExact(doc Document) (Result, error) {
	opts, err := s.options()
	if err != nil {
		return Result{}, err
	}
	m, err := newModel(doc, opts)
	if err != nil {
		return Result{}, err
	}
	return m.solveExact()
}

// SolveBeam forces the bounded beam-search solver. It is useful for large
// batches or for comparing heuristic and exact results.
func (s *Solver) SolveBeam(doc Document) (Result, error) {
	opts, err := s.options()
	if err != nil {
		return Result{}, err
	}
	m, err := newModel(doc, opts)
	if err != nil {
		return Result{}, err
	}
	return m.solveBeam()
}

// Adjudicate is a convenience wrapper around NewSolver and Solve.
func Adjudicate(doc Document, opts Options) (Result, error) {
	s, err := NewSolver(opts)
	if err != nil {
		return Result{}, err
	}
	return s.Solve(doc)
}

// String describes the solver's effective batch limits.
func (s *Solver) String() string {
	if s == nil {
		return "dataeng.Solver{defaults}"
	}
	return fmt.Sprintf("dataeng.Solver{maxCandidates:%d, exactMax:%d, beam:%d}",
		s.opts.MaxCandidates, s.opts.ExactMaxPages, s.opts.BeamWidth)
}
