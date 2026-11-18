package policy

import "sync/atomic"

// Engine serves admission webhooks from a compiled plan that can be
// hot-swapped atomically. The zero value is not usable; construct with
// NewEngine.
//
// Update compiles the new rule set completely before publishing it with
// a single atomic pointer swap, so a concurrent Evaluate always observes
// either the whole old plan or the whole new plan — never a partially
// compiled or partially polluted one.
type Engine struct {
	plan atomic.Pointer[Plan]
}

// NewEngine compiles rules and returns an Engine serving them.
func NewEngine(rules []Rule) (*Engine, error) {
	plan, err := Compile(rules)
	if err != nil {
		return nil, err
	}
	e := &Engine{}
	e.plan.Store(plan)
	return e, nil
}

// Update compiles rules and atomically replaces the active plan. On a
// compile error the previous plan keeps serving untouched.
func (e *Engine) Update(rules []Rule) error {
	plan, err := Compile(rules)
	if err != nil {
		return err
	}
	e.plan.Store(plan)
	return nil
}

// Plan returns the currently active plan snapshot.
func (e *Engine) Plan() *Plan { return e.plan.Load() }

// Evaluate runs short-circuit evaluation on the current plan snapshot.
func (e *Engine) Evaluate(obj any) Decision { return e.plan.Load().Evaluate(obj) }

// EvaluateAll runs merged evaluation on the current plan snapshot.
func (e *Engine) EvaluateAll(obj any) Decision { return e.plan.Load().EvaluateAll(obj) }
