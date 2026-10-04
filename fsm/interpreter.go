package fsm

import (
	"fmt"
	"time"
)

// Interpreter is a serial reference implementation: it folds a record log
// into protocol state one record at a time, validating every transition
// against the state table. It shares no logic with Engine so crash-recovery
// tests can cross-check the Engine against an independent oracle.
type Interpreter struct {
	table    *Table
	Sessions map[string]SessionView
	Keys     map[string]KeyBinding
}

// NewInterpreter returns an empty serial interpreter for table.
func NewInterpreter(table *Table) *Interpreter {
	return &Interpreter{
		table:    table,
		Sessions: make(map[string]SessionView),
		Keys:     make(map[string]KeyBinding),
	}
}

// Replay folds recs in order, returning an error if any record is
// inconsistent with the table or with the records before it.
func (i *Interpreter) Replay(recs []Record) error {
	for _, r := range recs {
		switch r.Kind {
		case KindSession:
			if _, dup := i.Sessions[r.Session]; dup {
				return fmt.Errorf("record %d: duplicate session %q", r.Seq, r.Session)
			}
			i.Sessions[r.Session] = SessionView{
				State:     i.table.Initial(),
				ExpiresAt: time.Unix(0, r.ExpiresAt).UTC(),
			}
		case KindTransition:
			sess, ok := i.Sessions[r.Session]
			if !ok {
				return fmt.Errorf("record %d: transition for unknown session %q", r.Seq, r.Session)
			}
			if sess.State != r.From {
				return fmt.Errorf("record %d: from-state %q does not match current %q", r.Seq, r.From, sess.State)
			}
			to, ok := i.table.Lookup(r.From, r.Action)
			if !ok || to != r.To {
				return fmt.Errorf("record %d: transition (%q, %q) -> %q not authorized by table", r.Seq, r.From, r.Action, r.To)
			}
			sess.State = r.To
			i.Sessions[r.Session] = sess
			if r.Key != "" {
				if b, dup := i.Keys[r.Key]; dup {
					if b.Session != r.Session || b.Action != r.Action {
						return fmt.Errorf("record %d: idempotency key %q rebound to a different action", r.Seq, r.Key)
					}
					return fmt.Errorf("record %d: idempotency key %q written twice", r.Seq, r.Key)
				}
				i.Keys[r.Key] = KeyBinding{Session: r.Session, Action: r.Action, To: r.To}
			}
		default:
			return fmt.Errorf("record %d: unknown kind %q", r.Seq, r.Kind)
		}
	}
	return nil
}
