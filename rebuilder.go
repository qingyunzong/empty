package dataeng

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// Level is one repetition/definition pair from the level stream.
type Level struct {
	Repetition int
	Definition int
}

// Row is a fully reconstructed row. When Null is true the row is a null
// list. Otherwise Elems is a non-nil slice (possibly empty) whose nil entries
// represent null elements.
type Row struct {
	Null  bool
	Elems []*int64
}

// Sentinel errors reported by the rebuilder. Callers should use errors.Is.
var (
	// ErrInvalidLevel marks a repetition/definition pair outside the fixed
	// schema (repetition 0 with definition 0-3, or repetition 1 with
	// definition 2-3).
	ErrInvalidLevel = errors.New("dataeng: invalid repetition/definition level pair")
	// ErrIllegalContinuation marks repetition level 1 without a current
	// non-null list to continue.
	ErrIllegalContinuation = errors.New("dataeng: repetition level 1 without a non-null list")
	// ErrMissingValue marks a definition level 3 whose value never arrived
	// before the value stream was sealed.
	ErrMissingValue = errors.New("dataeng: definition level 3 is missing a value")
	// ErrExtraValue marks unconsumed values left over after the level stream
	// ended.
	ErrExtraValue = errors.New("dataeng: value stream has unconsumed values")
	// ErrAlreadySealed marks an append on an already sealed stream.
	ErrAlreadySealed = errors.New("dataeng: stream is already sealed")
	// ErrTerminal marks any use of a rebuilder that has reached a terminal
	// state (committed, failed or awaiting confirmation).
	ErrTerminal = errors.New("dataeng: rebuilder has already finished")
	// ErrCommitUnknown must be returned by Transaction.Commit when the commit
	// outcome cannot be determined. The rebuilder does not retry and moves to
	// StateNeedsConfirmation instead.
	ErrCommitUnknown = errors.New("dataeng: transaction commit outcome unknown")
)

// Transaction stages reconstructed rows and finalizes them atomically.
// Implementations must not call back into the Rebuilder while its methods run.
type Transaction interface {
	// Stage buffers one complete row inside the open transaction.
	Stage(row Row) error
	// Commit finalizes the transaction. Returning ErrCommitUnknown keeps the
	// transaction unresolved for later confirmation; any other error fails the
	// rebuild and triggers Rollback.
	Commit() error
	// Rollback aborts an open transaction after a rebuild failure.
	Rollback() error
}

// Sink opens transactions for a rebuild run.
type Sink interface {
	Begin() (Transaction, error)
}

// State is the lifecycle state of a Rebuilder.
type State int

const (
	// StateOpen means at least one stream is still accepting data.
	StateOpen State = iota
	// StateCommitted means all rows were staged and the commit succeeded.
	StateCommitted
	// StateNeedsConfirmation means Commit returned ErrCommitUnknown; the
	// transaction is retained and must be confirmed out of band, without retry.
	StateNeedsConfirmation
	// StateFailed means validation or the transaction failed and it was rolled
	// back.
	StateFailed
)

// String returns the human-readable state name.
func (s State) String() string {
	switch s {
	case StateOpen:
		return "open"
	case StateCommitted:
		return "committed"
	case StateNeedsConfirmation:
		return "needs_confirmation"
	case StateFailed:
		return "failed"
	default:
		return "unknown"
	}
}

// Result is a point-in-time snapshot of a Rebuilder.
type Result struct {
	// State is the current lifecycle state.
	State State
	// Rows is the number of complete rows staged so far.
	Rows int
	// Err is the terminal error. It is non-nil in StateFailed and
	// StateNeedsConfirmation.
	Err error
	// Transaction is retained only in StateNeedsConfirmation so the caller can
	// determine the real commit outcome.
	Transaction Transaction
}

// Rebuilder reconstructs nullable list-of-nullable-int rows from a chunked
// repetition/definition level stream and a chunked non-null integer value
// stream. The fixed schema is:
//
//   - repetition level 0 starts a new row; definition 0 = null list,
//     1 = empty list, 2 = list with one null element, 3 = list with one
//     non-null element;
//   - repetition level 1 continues the current non-null list; definition 2
//     appends a null element, definition 3 appends a non-null element;
//   - only definition 3 consumes one value from the value stream.
//
// Complete rows are staged into a transaction; the transaction commits only
// after both streams are sealed and every validation passes. A commit with an
// unknown outcome is never retried.
type Rebuilder struct {
	mu   sync.Mutex
	cond sync.Cond

	sink Sink
	tx   Transaction

	levelBuf []Level
	valBuf   []int64

	levelsSealed bool
	valuesSealed bool

	haveRow   bool
	rowNull   bool
	elems     []*int64
	needValue bool

	rowCount int
	state    State
	err      error
}

// NewRebuilder opens a staging transaction on sink.
func NewRebuilder(sink Sink) (*Rebuilder, error) {
	if sink == nil {
		return nil, errors.New("dataeng: nil sink")
	}
	tx, err := sink.Begin()
	if err != nil {
		return nil, fmt.Errorf("dataeng: begin transaction: %w", err)
	}
	r := &Rebuilder{sink: sink, tx: tx}
	r.cond.L = &r.mu
	return r, nil
}

// AppendLevels appends one chunk of level pairs in caller order. It returns
// the terminal error once the rebuilder has failed or finished.
func (r *Rebuilder) AppendLevels(ctx context.Context, levels []Level) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.guardLocked(); err != nil {
		return err
	}
	if r.levelsSealed {
		return ErrAlreadySealed
	}
	if len(levels) > 0 {
		r.levelBuf = append(r.levelBuf, levels...)
	}
	r.pumpLocked()
	r.cond.Broadcast()
	return r.terminalErrLocked()
}

// AppendValues appends one chunk of non-null integer values in caller order.
// Values arriving before the level that consumes them stay buffered.
func (r *Rebuilder) AppendValues(ctx context.Context, values []int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.guardLocked(); err != nil {
		return err
	}
	if r.valuesSealed {
		return ErrAlreadySealed
	}
	if len(values) > 0 {
		r.valBuf = append(r.valBuf, values...)
	}
	r.pumpLocked()
	r.cond.Broadcast()
	return r.terminalErrLocked()
}

// SealLevels marks the level stream as finished. No further level chunks are
// accepted.
func (r *Rebuilder) SealLevels(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.guardLocked(); err != nil {
		return err
	}
	if r.levelsSealed {
		return ErrAlreadySealed
	}
	r.levelsSealed = true
	r.pumpLocked()
	r.cond.Broadcast()
	return r.terminalErrLocked()
}

// SealValues marks the value stream as finished. No further value chunks are
// accepted.
func (r *Rebuilder) SealValues(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.guardLocked(); err != nil {
		return err
	}
	if r.valuesSealed {
		return ErrAlreadySealed
	}
	r.valuesSealed = true
	r.pumpLocked()
	r.cond.Broadcast()
	return r.terminalErrLocked()
}

// Wait blocks until the rebuilder reaches a terminal state or ctx is done.
// A canceled context returns the context error with a non-terminal state; the
// rebuilder itself keeps running.
func (r *Rebuilder) Wait(ctx context.Context) (State, error) {
	stop := context.AfterFunc(ctx, func() {
		r.mu.Lock()
		r.cond.Broadcast()
		r.mu.Unlock()
	})
	defer stop()

	r.mu.Lock()
	defer r.mu.Unlock()
	for r.state == StateOpen {
		if err := ctx.Err(); err != nil {
			return r.state, err
		}
		r.cond.Wait()
	}
	return r.state, r.err
}

// Result returns a point-in-time snapshot of the rebuilder.
func (r *Rebuilder) Result() Result {
	r.mu.Lock()
	defer r.mu.Unlock()
	res := Result{State: r.state, Rows: r.rowCount, Err: r.err}
	if r.state == StateNeedsConfirmation {
		res.Transaction = r.tx
	}
	return res
}

// pumpLocked drains buffered input as far as possible. It pauses whenever the
// next step needs data that has not arrived yet, and fails on the first
// invalid combination or truncated stream.
func (r *Rebuilder) pumpLocked() {
	for r.state == StateOpen {
		if r.needValue {
			if len(r.valBuf) == 0 {
				if r.valuesSealed {
					r.failLocked(fmt.Errorf("%w: value stream ended before definition-3 value arrived", ErrMissingValue))
				}
				return
			}
			value := r.valBuf[0]
			r.valBuf = r.valBuf[1:]
			r.elems = append(r.elems, &value)
			r.needValue = false
			continue
		}

		if len(r.levelBuf) == 0 {
			if !r.levelsSealed {
				return
			}
			if r.haveRow {
				if err := r.stageLocked(); err != nil {
					r.failLocked(err)
					return
				}
			}
			if len(r.valBuf) > 0 {
				r.failLocked(fmt.Errorf("%w: %d value(s) without definition level 3", ErrExtraValue, len(r.valBuf)))
				return
			}
			if r.valuesSealed {
				r.commitLocked()
			}
			return
		}

		level := r.levelBuf[0]
		r.levelBuf = r.levelBuf[1:]
		if err := validateLevel(level, r.haveRow && !r.rowNull); err != nil {
			r.failLocked(err)
			return
		}

		if level.Repetition == 0 {
			if r.haveRow {
				if err := r.stageLocked(); err != nil {
					r.failLocked(err)
					return
				}
			}
			r.haveRow = true
			switch level.Definition {
			case 0:
				r.rowNull = true
				r.elems = nil
			case 1:
				r.rowNull = false
				r.elems = []*int64{}
			case 2:
				r.rowNull = false
				r.elems = []*int64{nil}
			case 3:
				r.rowNull = false
				r.elems = []*int64{}
				r.needValue = true
			}
			continue
		}

		if level.Definition == 2 {
			r.elems = append(r.elems, nil)
		} else {
			r.needValue = true
		}
	}
}

// validateLevel enforces the fixed schema. canContinue reports whether a
// non-null list is open for repetition level 1.
func validateLevel(level Level, canContinue bool) error {
	switch level.Repetition {
	case 0:
		if level.Definition < 0 || level.Definition > 3 {
			return fmt.Errorf("%w: repetition=0 definition=%d", ErrInvalidLevel, level.Definition)
		}
	case 1:
		if level.Definition != 2 && level.Definition != 3 {
			return fmt.Errorf("%w: repetition=1 definition=%d", ErrInvalidLevel, level.Definition)
		}
		if !canContinue {
			return fmt.Errorf("%w: repetition=1 while no non-null list is open", ErrIllegalContinuation)
		}
	default:
		return fmt.Errorf("%w: repetition=%d", ErrInvalidLevel, level.Repetition)
	}
	return nil
}

func (r *Rebuilder) stageLocked() error {
	row := Row{Null: r.rowNull}
	if !r.rowNull {
		row.Elems = r.elems
	}
	if err := r.tx.Stage(row); err != nil {
		return fmt.Errorf("dataeng: stage row: %w", err)
	}
	r.rowCount++
	r.haveRow = false
	r.rowNull = false
	r.elems = nil
	return nil
}

func (r *Rebuilder) commitLocked() {
	err := r.tx.Commit()
	switch {
	case errors.Is(err, ErrCommitUnknown):
		r.state = StateNeedsConfirmation
		r.err = err
	case err != nil:
		r.tx.Rollback()
		r.state = StateFailed
		r.err = fmt.Errorf("dataeng: commit failed: %w", err)
	default:
		r.state = StateCommitted
	}
	r.cond.Broadcast()
}

func (r *Rebuilder) failLocked(err error) {
	if r.state != StateOpen {
		return
	}
	r.state = StateFailed
	r.err = err
	r.tx.Rollback()
	r.cond.Broadcast()
}

func (r *Rebuilder) guardLocked() error {
	switch r.state {
	case StateFailed:
		return r.err
	case StateCommitted, StateNeedsConfirmation:
		return ErrTerminal
	default:
		return nil
	}
}

func (r *Rebuilder) terminalErrLocked() error {
	if r.state == StateFailed {
		return r.err
	}
	return nil
}
