// Package savepoint implements a named, nestable savepoint stack for the
// transaction manager used by the execution engine.
//
// Savepoints are pushed by name and may be nested. A rollback to a savepoint
// undoes every inner savepoint pushed after it, returning the locks and
// resource records held by those layers in reverse registration order; the
// target savepoint itself is retained. Releasing a savepoint removes only that
// layer and re-homes the records it holds to its parent layer (or to the
// engine/root when the outermost layer is released), leaving inner layers and
// their ownership untouched.
//
// Every invalid operation returns a sentinel error and leaves the state
// unchanged.
package savepoint

import "errors"

// Sentinel errors returned by the manager. Callers can use errors.Is to match
// them even when wrapped.
var (
	// ErrDuplicateSavepoint is returned when a savepoint name already exists
	// somewhere on the active stack.
	ErrDuplicateSavepoint = errors.New("savepoint: duplicate savepoint name")
	// ErrSavepointNotFound is returned when the named savepoint is not on the
	// stack and the stack itself is not empty.
	ErrSavepointNotFound = errors.New("savepoint: savepoint not found")
	// ErrEmptyStack is returned when a rollback or release is attempted while
	// no savepoint exists.
	ErrEmptyStack = errors.New("savepoint: savepoint stack is empty")
	// ErrNoActiveSavepoint is returned when a record is registered while no
	// savepoint exists to hold it.
	ErrNoActiveSavepoint = errors.New("savepoint: no active savepoint to hold the record")
	// ErrUnknownEvent is returned when Apply receives an event of an unknown
	// kind.
	ErrUnknownEvent = errors.New("savepoint: unknown event kind")
)

// RecordKind distinguishes the kinds of entries held by a savepoint.
type RecordKind int

const (
	// RecordResource is an ordinary resource registration.
	RecordResource RecordKind = iota + 1
	// RecordLock is a held lock, tracked the same way as a resource.
	RecordLock
)

// Record is a single lock or resource registration held by a savepoint layer.
type Record struct {
	ID   string
	Kind RecordKind
}

// Kind selects the operation carried by an Event.
type Kind int

const (
	// KindEstablish pushes a savepoint named Event.Name.
	KindEstablish Kind = iota + 1
	// KindRegister attaches Event.Record to the current top savepoint.
	KindRegister
	// KindRollback rolls back to the savepoint named Event.Name.
	KindRollback
	// KindRelease releases the savepoint named Event.Name.
	KindRelease
)

// Event is one numbered input operation.
type Event struct {
	Seq    int
	Kind   Kind
	Name   string
	Record Record
}

// StepResult is the full observable state after applying one event.
type StepResult struct {
	// Seq echoes the input event sequence number.
	Seq int
	// Stack lists the savepoint names from outermost to innermost.
	Stack []string
	// Owners maps every currently held record to the name of the savepoint
	// that owns it; the empty string marks engine/root ownership left behind
	// by a released outermost savepoint.
	Owners map[Record]string
	// Undone lists records returned during a rollback, in reverse
	// registration order across the popped inner layers. It is nil for
	// establish, register and release operations.
	Undone []Record
	// Err is the sentinel error for an invalid operation, or nil.
	Err error
}

// layer is one savepoint frame and the records registered while it was on top.
type layer struct {
	name    string
	records []Record
}

// rootOwner is the owner label for records committed to the engine after the
// outermost savepoint holding them is released.
const rootOwner = ""

// Manager is the savepoint state machine. The zero value is not usable; use
// NewManager.
type Manager struct {
	stack []*layer
	owner map[Record]string
}

// NewManager creates an empty manager.
func NewManager() *Manager {
	return &Manager{owner: map[Record]string{}}
}

// index returns the position of name in the stack, or -1 when absent.
func (m *Manager) index(name string) int {
	for i, frame := range m.stack {
		if frame.name == name {
			return i
		}
	}
	return -1
}

// Establish pushes a new named savepoint. It returns ErrDuplicateSavepoint
// without changing the state when the name already exists on the stack.
func (m *Manager) Establish(name string) error {
	if m.index(name) >= 0 {
		return ErrDuplicateSavepoint
	}
	m.stack = append(m.stack, &layer{name: name})
	return nil
}

// Register attaches rec to the current top savepoint. It returns
// ErrNoActiveSavepoint when the stack is empty.
func (m *Manager) Register(rec Record) error {
	if len(m.stack) == 0 {
		return ErrNoActiveSavepoint
	}
	top := m.stack[len(m.stack)-1]
	top.records = append(top.records, rec)
	m.owner[rec] = top.name
	return nil
}

// Rollback undoes every savepoint inner to the named target, returning the
// records they held in reverse registration order; the target layer and
// everything outer to it are retained. It returns ErrEmptyStack on an empty
// stack or ErrSavepointNotFound for an unknown name, in both cases without
// changing the state.
func (m *Manager) Rollback(name string) ([]Record, error) {
	if len(m.stack) == 0 {
		return nil, ErrEmptyStack
	}
	target := m.index(name)
	if target < 0 {
		return nil, ErrSavepointNotFound
	}
	var undone []Record
	for len(m.stack) > target+1 {
		top := m.stack[len(m.stack)-1]
		for i := len(top.records) - 1; i >= 0; i-- {
			rec := top.records[i]
			undone = append(undone, rec)
			delete(m.owner, rec)
		}
		m.stack = m.stack[:len(m.stack)-1]
	}
	return undone, nil
}

// Release removes only the named savepoint. Records held by that layer are
// re-homed to its parent layer, or to engine/root ownership when the
// outermost layer is released; inner layers and their ownership are never
// affected. It returns ErrEmptyStack on an empty stack or
// ErrSavepointNotFound for an unknown name, in both cases without changing
// the state.
func (m *Manager) Release(name string) ([]Record, error) {
	if len(m.stack) == 0 {
		return nil, ErrEmptyStack
	}
	target := m.index(name)
	if target < 0 {
		return nil, ErrSavepointNotFound
	}
	frame := m.stack[target]
	if target == 0 {
		for _, rec := range frame.records {
			m.owner[rec] = rootOwner
		}
	} else {
		parent := m.stack[target-1]
		for _, rec := range frame.records {
			parent.records = append(parent.records, rec)
			m.owner[rec] = parent.name
		}
	}
	m.stack = append(m.stack[:target], m.stack[target+1:]...)
	return nil, nil
}

// Depth returns the number of savepoints currently on the stack.
func (m *Manager) Depth() int {
	return len(m.stack)
}

// Stack returns a copy of the savepoint names from outermost to innermost.
func (m *Manager) Stack() []string {
	names := make([]string, len(m.stack))
	for i, frame := range m.stack {
		names[i] = frame.name
	}
	return names
}

// Owners returns a copy of the current record-to-owner mapping. The empty
// string denotes engine/root ownership.
func (m *Manager) Owners() map[Record]string {
	owners := make(map[Record]string, len(m.owner))
	for rec, name := range m.owner {
		owners[rec] = name
	}
	return owners
}

// Apply dispatches one numbered event against the manager and returns the
// full observable state after the step. An invalid event still returns the
// unchanged state alongside its sentinel error.
func (m *Manager) Apply(event Event) StepResult {
	result := StepResult{Seq: event.Seq}
	switch event.Kind {
	case KindEstablish:
		result.Err = m.Establish(event.Name)
	case KindRegister:
		result.Err = m.Register(event.Record)
	case KindRollback:
		result.Undone, result.Err = m.Rollback(event.Name)
	case KindRelease:
		result.Undone, result.Err = m.Release(event.Name)
	default:
		result.Err = ErrUnknownEvent
	}
	result.Stack = m.Stack()
	result.Owners = m.Owners()
	return result
}
