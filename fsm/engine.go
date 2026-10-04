package fsm

import (
	"errors"
	"time"
)

var (
	ErrSessionNotFound     = errors.New("fsm: session not found")
	ErrSessionExists       = errors.New("fsm: session already exists")
	ErrSessionExpired      = errors.New("fsm: session expired")
	ErrActionNotAuthorized = errors.New("fsm: action not authorized by state table")
	ErrIdempotencyConflict = errors.New("fsm: idempotency key bound to a different action")
)

// SessionView is the externally visible state of one session.
type SessionView struct {
	State     State
	ExpiresAt time.Time
}

// KeyBinding records what an idempotency key is bound to.
type KeyBinding struct {
	Session string
	Action  Action
	To      State
}

// Engine authorizes actions against a public Table and persists every state
// transition record to the WAL before applying it in memory and returning.
type Engine struct {
	table    *Table
	wal      *WAL
	now      func() time.Time
	sessions map[string]SessionView
	keys     map[string]KeyBinding
	recs     []Record
}

// Open opens (or recovers) an Engine on the log file at path. Existing
// records are replayed in log order, restoring sessions and key bindings.
// If now is nil, time.Now is used.
func Open(path string, table *Table, now func() time.Time) (*Engine, error) {
	if now == nil {
		now = time.Now
	}
	wal, recs, err := OpenWAL(path)
	if err != nil {
		return nil, err
	}
	e := &Engine{
		table:    table,
		wal:      wal,
		now:      now,
		sessions: make(map[string]SessionView),
		keys:     make(map[string]KeyBinding),
	}
	for _, r := range recs {
		e.apply(r)
	}
	return e, nil
}

// StartSession creates a session in the table's initial state, expiring ttl
// from now. The session record is persisted before StartSession returns.
func (e *Engine) StartSession(id string, ttl time.Duration) error {
	if id == "" {
		return ErrSessionNotFound
	}
	if _, ok := e.sessions[id]; ok {
		return ErrSessionExists
	}
	rec := Record{
		Kind:      KindSession,
		Session:   id,
		ExpiresAt: e.now().Add(ttl).UnixNano(),
	}
	if err := e.wal.Append(&rec); err != nil {
		return err
	}
	e.apply(rec)
	return nil
}

// Apply authorizes action a for the session against the state table,
// persists the transition record, applies it, and returns the new state.
//
// A repeated idempotency key bound to the same session and action replays
// the recorded outcome without a new write; the same key bound to a
// different action (or session) is rejected with ErrIdempotencyConflict.
// An empty key disables idempotency handling. Expired sessions reject new
// transitions with ErrSessionExpired.
func (e *Engine) Apply(session, key string, a Action) (State, error) {
	sess, ok := e.sessions[session]
	if !ok {
		return "", ErrSessionNotFound
	}
	if key != "" {
		if b, ok := e.keys[key]; ok {
			if b.Session != session || b.Action != a {
				return "", ErrIdempotencyConflict
			}
			return b.To, nil
		}
	}
	if !e.now().Before(sess.ExpiresAt) {
		return "", ErrSessionExpired
	}
	to, ok := e.table.Lookup(sess.State, a)
	if !ok {
		return "", ErrActionNotAuthorized
	}
	rec := Record{
		Kind:    KindTransition,
		Session: session,
		Key:     key,
		Action:  a,
		From:    sess.State,
		To:      to,
	}
	if err := e.wal.Append(&rec); err != nil {
		return "", err
	}
	e.apply(rec)
	return to, nil
}

// apply folds one persisted record into memory. It runs only after the
// record is durable.
func (e *Engine) apply(rec Record) {
	e.recs = append(e.recs, rec)
	switch rec.Kind {
	case KindSession:
		e.sessions[rec.Session] = SessionView{
			State:     e.table.Initial(),
			ExpiresAt: time.Unix(0, rec.ExpiresAt).UTC(),
		}
	case KindTransition:
		s := e.sessions[rec.Session]
		s.State = rec.To
		e.sessions[rec.Session] = s
		if rec.Key != "" {
			e.keys[rec.Key] = KeyBinding{Session: rec.Session, Action: rec.Action, To: rec.To}
		}
	}
}

// State reports the current state of a session.
func (e *Engine) State(session string) (State, bool) {
	s, ok := e.sessions[session]
	return s.State, ok
}

// Snapshot returns copies of the session and idempotency-key views.
func (e *Engine) Snapshot() (map[string]SessionView, map[string]KeyBinding) {
	sessions := make(map[string]SessionView, len(e.sessions))
	for k, v := range e.sessions {
		sessions[k] = v
	}
	keys := make(map[string]KeyBinding, len(e.keys))
	for k, v := range e.keys {
		keys[k] = v
	}
	return sessions, keys
}

// Records returns a copy of every record applied so far, in log order.
func (e *Engine) Records() []Record {
	out := make([]Record, len(e.recs))
	copy(out, e.recs)
	return out
}

// SimulateCrash mimics power loss without a clean shutdown. Test helper.
func (e *Engine) SimulateCrash() { e.wal.SimulateCrash() }

// Close closes the underlying WAL.
func (e *Engine) Close() error { return e.wal.Close() }
