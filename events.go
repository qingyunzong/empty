package quota

import "fmt"

// EventKind identifies the operation an Event replays.
type EventKind string

const (
	EventSetLimit EventKind = "set_limit"
	EventRename   EventKind = "rename" // alias Name -> Target
	EventConsume  EventKind = "consume"
	EventAcquire  EventKind = "acquire_lease"
	EventRelease  EventKind = "release_lease"
	EventSplit    EventKind = "split" // split direct edge Name <-> Target
)

// Event is a single recorded operation. Rename events model a principal
// being renamed: the old name stays behind as an alias and new requests
// to it are charged to the new root.
type Event struct {
	Kind    EventKind
	Name    string
	Target  string
	Amount  int64
	LeaseID string
}

// ReplayError wraps the error of a single replayed event with its index.
type ReplayError struct {
	Index int
	Event Event
	Err   error
}

func (e *ReplayError) Error() string {
	return fmt.Sprintf("quota: replay event %d (%s %q): %v", e.Index, e.Event.Kind, e.Event.Name, e.Err)
}

func (e *ReplayError) Unwrap() error { return e.Err }

// Replay applies events in order to s. Events that fail (for example a
// consume that exceeds the limit, or a rename that would close a cycle)
// are skipped and reported; replay always runs to completion. The
// returned slice is empty when every event applied cleanly.
func (s *Store) Replay(events []Event) []*ReplayError {
	var errs []*ReplayError
	for i, ev := range events {
		var err error
		switch ev.Kind {
		case EventSetLimit:
			s.SetLimit(ev.Name, ev.Amount)
		case EventRename:
			_, err = s.AddAlias(ev.Name, ev.Target)
		case EventConsume:
			err = s.Consume(ev.Name, ev.Amount)
		case EventAcquire:
			err = s.AcquireLease(ev.Name, ev.LeaseID, ev.Amount)
		case EventRelease:
			err = s.ReleaseLease(ev.Name, ev.LeaseID)
		case EventSplit:
			err = s.Split(ev.Name, ev.Target)
		default:
			err = fmt.Errorf("unknown event kind %q", ev.Kind)
		}
		if err != nil {
			errs = append(errs, &ReplayError{Index: i, Event: ev, Err: err})
		}
	}
	return errs
}
