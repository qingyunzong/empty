package dataeng

import "sort"

// QRESYNC event kinds used by Event.
const (
	// EventFetch represents an updated or newly fetched message.
	EventFetch = "fetch"

	// EventExpunge represents a classic IMAP EXPUNGE.
	EventExpunge = "expunge"

	// EventVanished represents a QRESYNC VANISHED response.
	EventVanished = "vanished"
)

// Event is one QRESYNC/CONDSTORE change observed for a mailbox. Events may
// be supplied in the order they arrived from the server, including replayed
// historical events; Replay puts them in causal order before applying them.
type Event struct {
	// Kind is EventFetch, EventExpunge or EventVanished.
	Kind string

	// UID is the affected message UID.
	UID uint32

	// ModSeq is the modification sequence associated with the event. It is
	// zero for servers without CONDSTORE.
	ModSeq uint64

	// Message carries the fetched content for EventFetch and is ignored for
	// removal events.
	Message Message

	// Earlier marks VANISHED (EARLIER) responses; only meaningful for
	// EventVanished.
	Earlier bool
}

// ReplayReport summarizes one Replay call.
type ReplayReport struct {
	// Applied is the number of events that changed or confirmed state.
	Applied int

	// Skipped is the number of fetch events ignored because an equal UID with
	// a newer MODSEQ was already recorded.
	Skipped int

	// Revived is the number of tombstoned UIDs brought back to life by a
	// later fetch event once events were ordered by MODSEQ.
	Revived int

	// Removed is the number of expunge/vanished events that produced or
	// refreshed a tombstone.
	Removed int

	// UIDNext and HighestModSeq are the cursors after replay.
	UIDNext       uint32
	HighestModSeq uint64
}

// Replay applies a batch of QRESYNC/CONDSTORE events to the active
// generation. Events are first fully validated and then stably sorted by
// MODSEQ (events without MODSEQ keep their input order and run first), so a
// batch delivered out of order converges to the same snapshot as applying the
// complete message listing. Fetch events after a removal revive the UID,
// while removal events after a fetch tombstone it; the ordering guarantees
// the correct winner.
func (s *State) Replay(mailbox string, events []Event) (ReplayReport, error) {
	if mailbox == "" {
		return ReplayReport{}, ErrInvalidArgument
	}
	for _, event := range events {
		if event.UID == 0 {
			return ReplayReport{}, ErrInvalidArgument
		}
		switch event.Kind {
		case EventFetch:
			if event.Message.UID != event.UID || event.Message.Digest.IsZero() {
				return ReplayReport{}, ErrInvalidArgument
			}
		case EventExpunge, EventVanished:
		default:
			return ReplayReport{}, ErrInvalidArgument
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	gen, err := s.activeGenerationForLocked(mailbox)
	if err != nil {
		return ReplayReport{}, err
	}

	ordered := make([]Event, len(events))
	copy(ordered, events)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].ModSeq < ordered[j].ModSeq
	})

	report := ReplayReport{}
	for _, event := range ordered {
		switch event.Kind {
		case EventFetch:
			if _, tombstoned := gen.Tombstones[event.UID]; tombstoned {
				delete(gen.Tombstones, event.UID)
				report.Revived++
			}
			existing, seen := gen.Messages[event.UID]
			if seen && event.ModSeq != 0 && existing.ModSeq != 0 && event.ModSeq < existing.ModSeq {
				report.Skipped++
				continue
			}
			if err := s.applyFetchLocked(gen, event.Message); err != nil {
				return ReplayReport{}, err
			}
			report.Applied++
		case EventExpunge:
			s.removeLocked(gen, event.UID, event.ModSeq, ReasonExpunge, false)
			report.Removed++
			report.Applied++
		case EventVanished:
			s.removeLocked(gen, event.UID, event.ModSeq, ReasonVanished, event.Earlier)
			report.Removed++
			report.Applied++
		}
	}

	report.UIDNext = gen.UIDNext
	report.HighestModSeq = gen.HighestModSeq
	return report, nil
}
