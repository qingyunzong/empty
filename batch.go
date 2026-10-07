package railplan

import (
	"errors"
	"sort"
)

// validateBatch checks every new layout of the batch against all
// reservations outside the batch and against the other new layouts
// inside the batch. The batch's own old reservations are ignored.
func (p *Planner) validateBatch(changes map[string][]Reservation) error {
	excluded := make(map[string]bool, len(changes))
	for train := range changes {
		excluded[train] = true
	}
	for train, next := range changes {
		if err := validateLayout(next); err != nil {
			return errTrain{train, err}
		}
		if err := p.checkFree(next, excluded); err != nil {
			return err
		}
	}
	// Cross-check new layouts of different batch trains against each other.
	type owned struct {
		train string
		r     Reservation
	}
	var all []owned
	for train, next := range changes {
		for _, r := range next {
			all = append(all, owned{train, r})
		}
	}
	for i := 0; i < len(all); i++ {
		for j := i + 1; j < len(all); j++ {
			a, b := all[i], all[j]
			if a.train != b.train && a.r.Track == b.r.Track && a.r.Span.Overlaps(b.r.Span) {
				return &ConflictError{
					Track:  a.r.Track,
					Span:   a.r.Span,
					Others: []string{b.train},
				}
			}
		}
	}
	return nil
}

type errTrain struct {
	train string
	err   error
}

func (e errTrain) Error() string { return "railplan: train " + e.train + ": " + e.err.Error() }
func (e errTrain) Unwrap() error { return e.err }

// AtomicReschedule atomically replaces the layouts of every train in
// changes. The batch's old reservations are removed from consideration
// before all new reservations are checked, so trains inside the batch
// may swap intervals with each other. On any failure the whole previous
// layout of the batch is kept.
func (p *Planner) AtomicReschedule(changes map[string][]Reservation) error {
	if err := p.validateBatch(changes); err != nil {
		return err
	}
	for train, next := range changes {
		p.res[train] = cloneRes(next)
	}
	return nil
}

// ErrCrash is returned by Intent.Execute when a simulated crash interrupts
// the intent before completion.
var ErrCrash = errors.New("railplan: simulated crash before intent completion")

// Intent is a persistent multi-train reschedule with crash recovery.
//
// The intent journals the old layouts and a commit record. Execute may
// be interrupted by a simulated crash at any step (CrashAt). Recover
// then finishes the intent deterministically: if the commit record was
// written the whole new batch layout is rolled forward, otherwise every
// already-applied train is rolled back to its old layout. Recovery never
// leaves a mix where only some trains of the batch were rescheduled.
type Intent struct {
	Changes map[string][]Reservation

	// CommitAfter is the number of train layouts applied before the
	// commit record is written. 0 commits before applying anything;
	// the default (len(Changes)) commits only after all trains applied.
	CommitAfter int

	// CrashAt simulates a crash at the given execution step; -1 disables.
	CrashAt int

	order     []string
	old       map[string][]Reservation
	applied   map[string]bool
	committed bool
	done      bool
	step      int
}

// NewIntent builds an intent for the given batch changes.
func NewIntent(changes map[string][]Reservation) *Intent {
	order := make([]string, 0, len(changes))
	for train := range changes {
		order = append(order, train)
	}
	sort.Strings(order)
	return &Intent{
		Changes:     changes,
		CommitAfter: len(order),
		CrashAt:     -1,
		order:       order,
		applied:     map[string]bool{},
	}
}

// crashed reports whether the current step is the injected crash step.
func (it *Intent) crashed() bool {
	s := it.step
	it.step++
	return s == it.CrashAt
}

// Execute runs the intent. It returns ErrCrash if the injected crash
// step is reached, a validation error if the batch is infeasible (old
// layouts kept), or nil once the whole new layout is durable.
func (it *Intent) Execute(p *Planner) error {
	if it.done {
		return nil
	}
	if it.crashed() {
		return ErrCrash
	}
	if err := p.validateBatch(it.Changes); err != nil {
		return err
	}
	if it.old == nil {
		it.old = make(map[string][]Reservation, len(it.order))
		for _, train := range it.order {
			it.old[train] = cloneRes(p.res[train])
		}
	}
	if it.CommitAfter <= 0 {
		if it.crashed() {
			return ErrCrash
		}
		it.committed = true
	}
	appliedCount := 0
	for _, train := range it.order {
		if it.crashed() {
			return ErrCrash
		}
		p.res[train] = cloneRes(it.Changes[train])
		it.applied[train] = true
		appliedCount++
		if appliedCount == it.CommitAfter {
			if it.crashed() {
				return ErrCrash
			}
			it.committed = true
		}
	}
	if it.crashed() {
		return ErrCrash
	}
	it.done = true
	return nil
}

// Recover restores atomicity after a crash: committed intents roll
// forward to the whole new batch layout, uncommitted intents roll back
// to the whole old batch layout. The result is never a partial batch.
func (it *Intent) Recover(p *Planner) {
	if it.done {
		return
	}
	if it.committed {
		for _, train := range it.order {
			p.res[train] = cloneRes(it.Changes[train])
		}
	} else {
		for train := range it.applied {
			if it.old[train] == nil {
				delete(p.res, train)
			} else {
				p.res[train] = cloneRes(it.old[train])
			}
		}
	}
	it.done = true
}
