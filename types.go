package formal

import (
	"bytes"
	"errors"
	"fmt"
	"time"
)

// State is the durable state of one transaction attempt.
type State uint8

const (
	// StateAbsent means no attempt is known for the reference.
	StateAbsent State = iota
	// StatePrepared means the half message is durable but invisible.
	StatePrepared
	// StateCommitted means the message is part of the deliverable set.
	StateCommitted
	// StateRolledBack means the message will never become deliverable.
	StateRolledBack
)

func (s State) String() string {
	switch s {
	case StateAbsent:
		return "absent"
	case StatePrepared:
		return "prepared"
	case StateCommitted:
		return "committed"
	case StateRolledBack:
		return "rolled_back"
	default:
		return fmt.Sprintf("state(%d)", uint8(s))
	}
}

// Final reports whether the state is a terminal decision.
func (s State) Final() bool {
	return s == StateCommitted || s == StateRolledBack
}

// Ref identifies one generation of a transaction number.
//
// ID is the reusable transaction number. Gen is allocated monotonically when a
// prepare is made durable, so a confirmation for an older generation can never
// be mistaken for a confirmation of a newer attempt that reuses the same ID.
type Ref struct {
	ID  string `json:"id"`
	Gen uint64 `json:"gen"`
}

func (r Ref) String() string {
	return fmt.Sprintf("%s#%d", r.ID, r.Gen)
}

func (r Ref) valid() bool {
	return r.ID != "" && r.Gen != 0
}

// Message is the payload stored with a prepared transaction. ID is the
// caller's message identity; delivery deduplication is keyed by the transaction
// generation (Ref), not by this field.
type Message struct {
	ID      string            `json:"id"`
	Topic   string            `json:"topic,omitempty"`
	Body    []byte            `json:"body,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

func (m Message) clone() Message {
	out := Message{ID: m.ID, Topic: m.Topic}
	if m.Body != nil {
		out.Body = append([]byte(nil), m.Body...)
	}
	if m.Headers != nil {
		out.Headers = make(map[string]string, len(m.Headers))
		for k, v := range m.Headers {
			out.Headers[k] = v
		}
	}
	return out
}

func (m Message) equal(other Message) bool {
	if m.ID != other.ID || m.Topic != other.Topic || !bytes.Equal(m.Body, other.Body) {
		return false
	}
	if len(m.Headers) != len(other.Headers) {
		return false
	}
	for k, v := range m.Headers {
		if other.Headers[k] != v {
			return false
		}
	}
	return true
}

// PrepareRequest starts a transaction attempt.
type PrepareRequest struct {
	// ID is the caller-visible transaction number. It may be reused after the
	// previous generation reaches a final decision. If empty, the coordinator
	// generates an ID.
	ID string
	// Message is copied into the durable log before Prepare returns.
	Message Message
	// Timeout selects when the first transaction check becomes due. A zero
	// value uses the coordinator default.
	Timeout time.Duration
}

// Receipt is the durable identity of a prepared attempt.
type Receipt struct {
	Ref       Ref
	ExpiresAt time.Time
	// Duplicate is true when an identical, still-prepared attempt for the same
	// transaction ID was already present.
	Duplicate bool
}

// Decision is the stored outcome of a commit or rollback request.
type Decision struct {
	Ref       Ref
	State     State
	DecidedAt time.Time
	Reason    string
	// Duplicate is true when this reference already had a final decision.
	Duplicate bool
	// Conflict is true when the request asked for the opposite decision. The
	// stored decision is still returned unchanged.
	Conflict bool
}

// CheckRequest describes a prepared transaction whose check deadline or
// re-check interval has elapsed.
type CheckRequest struct {
	Ref        Ref
	Message    Message
	PreparedAt time.Time
	Deadline   time.Time
	Checks     int
	LastCheck  time.Time
	NextCheck  time.Time
	// Exhausted reports that the configured maximum number of checks has been
	// reached. The coordinator does not decide on the caller's behalf.
	Exhausted bool
}

// Attempt is an immutable snapshot of a transaction attempt.
type Attempt struct {
	Ref        Ref
	Message    Message
	State      State
	PreparedAt time.Time
	Deadline   time.Time
	Checks     int
	LastCheck  time.Time
	NextCheck  time.Time
	DecidedAt  time.Time
	Reason     string
}

// Delivery is one transaction generation in the deliverable set. Uniqueness is
// by Ref.
type Delivery struct {
	Ref         Ref
	Message     Message
	CommittedAt time.Time
}

// Stats is a point-in-time summary of the coordinator.
type Stats struct {
	Records        int
	NextGeneration uint64
	Attempts       int
	Prepared       int
	Delivered      int
	// TornTailBytes is the number of bytes discarded from a partial record
	// when the log was opened.
	TornTailBytes int
	Broken        bool
}

var (
	// ErrStaleGeneration matches errors caused by a confirmation for an older
	// generation whose attempt is no longer known.
	ErrStaleGeneration = errors.New("formal: stale transaction generation")
	// ErrUnknownTransaction matches confirmations for unknown references.
	ErrUnknownTransaction = errors.New("formal: unknown transaction")
	// ErrInFlight matches attempts to reuse a transaction ID whose current
	// generation is still prepared.
	ErrInFlight = errors.New("formal: transaction generation is still prepared")
	// ErrAlreadyDecided matches MarkChecked calls for a finalized attempt.
	ErrAlreadyDecided = errors.New("formal: transaction already decided")
	// ErrInvalidRef matches malformed transaction references.
	ErrInvalidRef = errors.New("formal: invalid transaction reference")
	// ErrInvalidMessage matches messages without an ID.
	ErrInvalidMessage = errors.New("formal: message id is required")
	// ErrInvalidTimeout matches negative prepare timeouts.
	ErrInvalidTimeout = errors.New("formal: invalid transaction timeout")
	// ErrInvalidOption matches invalid coordinator options.
	ErrInvalidOption = errors.New("formal: invalid coordinator option")
	// ErrCorruptLog matches complete log frames that fail validation.
	ErrCorruptLog = errors.New("formal: corrupt transaction log")
	// ErrRecordTooLarge matches a record that exceeds the log format limit.
	ErrRecordTooLarge = errors.New("formal: transaction record too large")
)

// InFlightError reports a prepare that would replace an unresolved attempt.
type InFlightError struct {
	Ref Ref
}

func (e *InFlightError) Error() string {
	return fmt.Sprintf("%v: %s", ErrInFlight, e.Ref)
}

func (e *InFlightError) Unwrap() error {
	return ErrInFlight
}

// StaleConfirmationError reports a confirmation for an old generation that
// cannot be applied. Current is the current generation for the same ID.
type StaleConfirmationError struct {
	Ref     Ref
	Current Ref
}

func (e *StaleConfirmationError) Error() string {
	return fmt.Sprintf("%v: confirmation %s, current generation %s", ErrStaleGeneration, e.Ref, e.Current)
}

func (e *StaleConfirmationError) Unwrap() error {
	return ErrStaleGeneration
}

type config struct {
	now             func() time.Time
	defaultTimeout  time.Duration
	recheckInterval time.Duration
	maxChecks       int
}

func defaultConfig() config {
	return config{
		now:             time.Now,
		defaultTimeout:  30 * time.Second,
		recheckInterval: 10 * time.Second,
		maxChecks:       0,
	}
}

// Option configures a Coordinator.
type Option func(*config)

// WithClock replaces the wall clock. It is useful for deterministic tests and
// for embedding the coordinator in a system with its own time source.
func WithClock(now func() time.Time) Option {
	return func(c *config) {
		c.now = now
	}
}

// WithDefaultTimeout sets the prepare timeout used when a request leaves it
// zero.
func WithDefaultTimeout(d time.Duration) Option {
	return func(c *config) {
		c.defaultTimeout = d
	}
}

// WithRecheckInterval sets the minimum spacing between two checks of the same
// prepared transaction.
func WithRecheckInterval(d time.Duration) Option {
	return func(c *config) {
		c.recheckInterval = d
	}
}

// WithMaxChecks sets the number of checks after which CheckRequest.Exhausted
// becomes true. Zero means unlimited.
func WithMaxChecks(n int) Option {
	return func(c *config) {
		c.maxChecks = n
	}
}
