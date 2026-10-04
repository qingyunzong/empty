// Package handshake simulates a challenge/response handshake driven by
// externally delivered events (responses, timeouts, revocations).
//
// Events are grouped into ticks and applied strictly in input order.
// Each challenge is a finite state machine; terminal states are
// persistent and can never be overwritten.
package handshake

import "errors"

// State is the lifecycle state of a single challenge.
type State int

const (
	StatePending  State = iota // awaiting a response
	StateVerified              // terminal: a response was accepted
	StateExpired               // terminal: the challenge timed out
	StateRevoked               // terminal: the challenge was revoked
)

// Terminal reports whether the state is final. Terminal states are
// persistent: no event can move a challenge out of them.
func (s State) Terminal() bool { return s != StatePending }

func (s State) String() string {
	switch s {
	case StatePending:
		return "pending"
	case StateVerified:
		return "verified"
	case StateExpired:
		return "expired"
	case StateRevoked:
		return "revoked"
	default:
		return "unknown"
	}
}

// EventKind identifies the type of a handshake event.
type EventKind int

const (
	EventResponse EventKind = iota // a response carrying a digest
	EventTimeout                   // the challenge's deadline elapsed
	EventRevoke                    // the challenge was revoked
)

func (k EventKind) String() string {
	switch k {
	case EventResponse:
		return "response"
	case EventTimeout:
		return "timeout"
	case EventRevoke:
		return "revoke"
	default:
		return "unknown"
	}
}

// transitions is the finite state table: transitions[state][kind] is the
// next state when an event of that kind arrives in that state. A missing
// entry means the event is invalid for that state and must be rejected.
// Terminal states deliberately have no entries.
var transitions = map[State]map[EventKind]State{
	StatePending: {
		EventResponse: StateVerified,
		EventTimeout:  StateExpired,
		EventRevoke:   StateRevoked,
	},
}

// Event is a single handshake occurrence delivered to the simulator.
type Event struct {
	ChallengeID string
	Kind        EventKind
	Digest      string // response payload; bound to the challenge on success
}

// Challenge is the tracked state of one handshake challenge.
type Challenge struct {
	ID     string
	State  State
	Digest string // digest bound by the accepted response
}

// Rejection records an event that was not applied, with the reason.
type Rejection struct {
	Tick   uint64
	Event  Event
	Reason error
}

var (
	ErrUnknownChallenge = errors.New("handshake: unknown challenge ID")
	ErrInvalidEvent     = errors.New("handshake: event not allowed in current state")
	ErrDuplicateEvent   = errors.New("handshake: duplicate event for terminal challenge")
	ErrDigestMismatch   = errors.New("handshake: response digest does not match bound digest")
	ErrEmptyDigest      = errors.New("handshake: response carries an empty digest")
	ErrChallengeExists  = errors.New("handshake: challenge ID already registered")
)

// AppliedEvent is an audit record of an event that changed a challenge.
type AppliedEvent struct {
	Tick  uint64
	Event Event
	From  State
	To    State
}

// Simulator tracks challenges and applies events tick by tick.
type Simulator struct {
	challenges map[string]*Challenge
	tick       uint64
	history    []AppliedEvent
}

// New returns an empty Simulator.
func New() *Simulator {
	return &Simulator{challenges: make(map[string]*Challenge)}
}

// Register adds a new pending challenge. It fails if the ID is taken.
func (s *Simulator) Register(id string) error {
	if _, ok := s.challenges[id]; ok {
		return ErrChallengeExists
	}
	s.challenges[id] = &Challenge{ID: id, State: StatePending}
	return nil
}

// Challenge returns a snapshot of the challenge with the given ID.
func (s *Simulator) Challenge(id string) (Challenge, bool) {
	c, ok := s.challenges[id]
	if !ok {
		return Challenge{}, false
	}
	return *c, true
}

// Tick returns the index of the last applied tick (0 before any tick).
func (s *Simulator) Tick() uint64 { return s.tick }

// History returns the audit log of applied events, in application order.
func (s *Simulator) History() []AppliedEvent {
	out := make([]AppliedEvent, len(s.history))
	copy(out, s.history)
	return out
}

// ApplyTick applies one tick of events strictly in input order and then
// advances the tick counter. Events that fail the state-table check are
// rejected and reported; they never mutate state. When a verification
// success and a timeout (or any other event) for the same challenge land
// in the same tick, the one earlier in the input wins.
func (s *Simulator) ApplyTick(events []Event) []Rejection {
	s.tick++
	var rejections []Rejection
	for _, ev := range events {
		if err := s.apply(ev); err != nil {
			rejections = append(rejections, Rejection{Tick: s.tick, Event: ev, Reason: err})
		}
	}
	return rejections
}

// apply checks one event against the finite state table and, if valid,
// mutates the challenge. Terminal states are never overwritten.
func (s *Simulator) apply(ev Event) error {
	c, ok := s.challenges[ev.ChallengeID]
	if !ok {
		return ErrUnknownChallenge
	}
	next, ok := transitions[c.State][ev.Kind]
	if !ok {
		// Out-of-order or duplicate event on a terminal challenge.
		// A repeated response is checked against the bound digest so a
		// rebind attempt is distinguishable from a harmless duplicate.
		if c.State == StateVerified && ev.Kind == EventResponse {
			if ev.Digest != c.Digest {
				return ErrDigestMismatch
			}
			return ErrDuplicateEvent
		}
		return ErrInvalidEvent
	}
	if ev.Kind == EventResponse && ev.Digest == "" {
		return ErrEmptyDigest
	}
	from := c.State
	c.State = next
	if ev.Kind == EventResponse {
		c.Digest = ev.Digest // bind the digest to the challenge ID
	}
	s.history = append(s.history, AppliedEvent{Tick: s.tick, Event: ev, From: from, To: next})
	return nil
}
