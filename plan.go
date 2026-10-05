// Package plan executes multi-step mutation plans. Every step carries a
// precondition, a forward action producing a post-image, and an inverse
// action. When a batch fails midway, applied steps are rolled back in
// reverse order; steps whose inverse action fails are kept as a pending
// recovery tail instead of being forcibly overwritten.
package plan

import "fmt"

// Value describes the state of a key. OK is false when the key is absent.
type Value struct {
	Data string
	OK   bool
}

// Store is the minimal state backend a plan runs against.
type Store interface {
	Get(key string) Value
	// CAS sets key to set only when the current state equals expect.
	// It returns ErrConflict and changes nothing otherwise, so unknown
	// external modifications are never silently overwritten.
	CAS(key string, expect, set Value) error
}

// Step is one planned mutation together with its inverse.
type Step struct {
	Name  string
	Pre   func(Store) error // precondition, checked before Apply; nil means none
	Apply func(Store) error // forward action producing the post-image
	Undo  func(Store) error // inverse action of Apply; nil means irreversible
}

// Result reports the outcome of Execute.
type Result struct {
	Applied []string // steps whose Apply succeeded, in plan order
	Undone  []string // steps successfully rolled back, in plan order
	Pending []Step   // recovery tail: steps still applied, in plan order
	Err     error    // forward-phase failure, nil on success
	UndoErr error    // first inverse-action failure, if any
}

// FullyRecovered reports whether no applied step remains unrecovered.
func (r Result) FullyRecovered() bool { return len(r.Pending) == 0 }

// Execute applies steps in order. On the first precondition or apply
// failure it rolls back already-applied steps in reverse order. A failed
// inverse action does not stop the remaining rollbacks; the step is
// recorded in the Pending tail as evidence of incomplete recovery.
func Execute(s Store, steps []Step) (res Result) {
	var applied []Step
	for i, st := range steps {
		if st.Pre != nil {
			if err := st.Pre(s); err != nil {
				res.Err = fmt.Errorf("step %d (%s): precondition: %w", i, st.Name, err)
				break
			}
		}
		if st.Apply == nil {
			res.Err = fmt.Errorf("step %d (%s): no apply action", i, st.Name)
			break
		}
		if err := st.Apply(s); err != nil {
			res.Err = fmt.Errorf("step %d (%s): apply: %w", i, st.Name, err)
			break
		}
		applied = append(applied, st)
		res.Applied = append(res.Applied, st.Name)
	}
	if res.Err == nil {
		return res
	}
	for i := len(applied) - 1; i >= 0; i-- {
		st := applied[i]
		if st.Undo == nil {
			res.Pending = append([]Step{st}, res.Pending...)
			continue
		}
		if err := st.Undo(s); err != nil {
			if res.UndoErr == nil {
				res.UndoErr = fmt.Errorf("undo %s: %w", st.Name, err)
			}
			res.Pending = append([]Step{st}, res.Pending...)
			continue
		}
		res.Undone = append([]string{st.Name}, res.Undone...)
	}
	return res
}

// SetStep returns a Step changing key from the pre-image "from" to the
// post-image "to". Both directions are compare-and-swap guarded, so an
// unexpected current value (an external modification) aborts the step
// instead of being overwritten.
func SetStep(key string, from, to Value) Step {
	return Step{
		Name: fmt.Sprintf("set %s", key),
		Pre: func(s Store) error {
			if got := s.Get(key); got != from {
				return fmt.Errorf("key %s is %+v, want %+v", key, got, from)
			}
			return nil
		},
		Apply: func(s Store) error { return s.CAS(key, from, to) },
		Undo:  func(s Store) error { return s.CAS(key, to, from) },
	}
}

// CreateStep returns a Step creating key with the given content.
func CreateStep(key, data string) Step {
	return SetStep(key, Value{}, Value{Data: data, OK: true})
}

// DeleteStep returns a Step deleting key, which must currently hold from.
func DeleteStep(key string, from Value) Step {
	return SetStep(key, from, Value{})
}
