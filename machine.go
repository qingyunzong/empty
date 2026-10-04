package protocol

import (
	"errors"
	"fmt"
	"time"
)

var (
	// ErrActionNotAuthorized is returned when the state table has no
	// transition for the action in the current state.
	ErrActionNotAuthorized = errors.New("protocol: action not authorized in current state")
	// ErrIdempotencyConflict is returned when an idempotency key that is
	// already bound to one action is reused with a different action.
	ErrIdempotencyConflict = errors.New("protocol: idempotency key already bound to a different action")
	// ErrSessionExpired is returned when a transition is attempted on an
	// expired session.
	ErrSessionExpired = errors.New("protocol: session expired")
	// ErrEmptyIdempotencyKey is returned when Apply is called without an
	// idempotency key.
	ErrEmptyIdempotencyKey = errors.New("protocol: empty idempotency key")
	// ErrSessionMismatch is returned when a journal belongs to a different
	// session than the one being opened.
	ErrSessionMismatch = errors.New("protocol: journal belongs to a different session")
	// ErrCorruptJournal is returned when journaled records are inconsistent
	// with each other.
	ErrCorruptJournal = errors.New("protocol: corrupt journal")
)

// KeyBinding records what an idempotency key is bound to: the action it
// authorized and the transition it produced.
type KeyBinding struct {
	Action string
	From   string
	To     string
}

// Config configures Open.
type Config struct {
	Table   *Table
	Store   *Store
	Session string
	TTL     time.Duration
	// Now supplies the current time; nil means time.Now. Tests inject a
	// fake clock so expiry is deterministic across restarts.
	Now func() time.Time
}

// Machine is a session-bound state machine. Transitions are authorized by
// the public Table, journaled before they take effect, and deduplicated by
// idempotency key.
type Machine struct {
	table     *Table
	store     *Store
	session   string
	state     string
	expiresAt time.Time
	now       func() time.Time
	seq       int
	keys      map[string]KeyBinding
}

// Open creates or recovers a session machine. If the store is empty a
// session header is journaled; otherwise the journal is replayed and the
// machine resumes from the persisted state, key bindings, and expiry.
func Open(cfg Config) (*Machine, error) {
	if cfg.Table == nil {
		return nil, errors.New("protocol: nil table")
	}
	if cfg.Store == nil {
		return nil, errors.New("protocol: nil store")
	}
	if cfg.Session == "" {
		return nil, errors.New("protocol: empty session id")
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	m := &Machine{
		table:   cfg.Table,
		store:   cfg.Store,
		session: cfg.Session,
		state:   cfg.Table.Initial,
		now:     now,
		keys:    make(map[string]KeyBinding),
	}
	recs := cfg.Store.Records()
	if len(recs) == 0 {
		m.expiresAt = now().Add(cfg.TTL)
		hdr := Record{Kind: KindSession, Session: cfg.Session, ExpiresUnixNano: m.expiresAt.UnixNano()}
		if err := cfg.Store.Append(hdr); err != nil {
			return nil, err
		}
		return m, nil
	}
	hdr := recs[0]
	if hdr.Kind != KindSession {
		return nil, fmt.Errorf("%w: first record is %q", ErrCorruptJournal, hdr.Kind)
	}
	if hdr.Session != cfg.Session {
		return nil, ErrSessionMismatch
	}
	m.expiresAt = time.Unix(0, hdr.ExpiresUnixNano)
	var prev Record
	havePrev := false
	for _, r := range recs[1:] {
		// A retried append after an uncertain sync can duplicate a
		// record; identical consecutive duplicates are harmless.
		if havePrev && r == prev {
			continue
		}
		if r.Kind != KindTransition || r.From != m.state || r.Seq != m.seq+1 {
			return nil, fmt.Errorf("%w: seq %d", ErrCorruptJournal, r.Seq)
		}
		b := KeyBinding{Action: r.Action, From: r.From, To: r.To}
		if existing, ok := m.keys[r.Key]; ok && existing != b {
			return nil, fmt.Errorf("%w: key %q rebound", ErrCorruptJournal, r.Key)
		}
		m.keys[r.Key] = b
		m.state = r.To
		m.seq = r.Seq
		prev = r
		havePrev = true
	}
	return m, nil
}

// State returns the current state.
func (m *Machine) State() string { return m.state }

// ExpiresAt returns the persisted session expiry.
func (m *Machine) ExpiresAt() time.Time { return m.expiresAt }

// Bindings returns a copy of the idempotency key bindings.
func (m *Machine) Bindings() map[string]KeyBinding {
	out := make(map[string]KeyBinding, len(m.keys))
	for k, v := range m.keys {
		out[k] = v
	}
	return out
}

// Apply attempts a transition. The transition record is persisted to the
// journal before the new state takes effect and before Apply returns.
//
// Reusing an idempotency key with the action it is bound to replays the
// recorded result without a new transition or journal write; reusing it
// with a different action fails with ErrIdempotencyConflict. Expired
// sessions reject every transition with ErrSessionExpired.
func (m *Machine) Apply(action, key string) (string, error) {
	if key == "" {
		return m.state, ErrEmptyIdempotencyKey
	}
	if !m.now().Before(m.expiresAt) {
		return m.state, ErrSessionExpired
	}
	if b, ok := m.keys[key]; ok {
		if b.Action != action {
			return m.state, ErrIdempotencyConflict
		}
		return b.To, nil
	}
	next, ok := m.table.Step(m.state, action)
	if !ok {
		return m.state, ErrActionNotAuthorized
	}
	rec := Record{
		Kind:    KindTransition,
		Session: m.session,
		Seq:     m.seq + 1,
		Key:     key,
		Action:  action,
		From:    m.state,
		To:      next,
	}
	if err := m.store.Append(rec); err != nil {
		return m.state, err
	}
	m.seq++
	m.keys[key] = KeyBinding{Action: action, From: m.state, To: next}
	m.state = next
	return next, nil
}
