package ticketlog

import (
	"fmt"
	"math/rand"
)

// Generate produces a random valid log with the given number of tickets
// and events, using the same rules Check enforces. The first event is
// always a LIMIT.
func Generate(rng *rand.Rand, numTickets, numEvents int) []Event {
	if numTickets < 1 {
		numTickets = 1
	}
	ids := make([]string, numTickets)
	for i := range ids {
		ids[i] = fmt.Sprintf("T%d", i+1)
	}

	const (
		sNone = iota
		sPending
		sGranted
	)
	state := make([]int, numTickets)
	amount := make([]int, numTickets)

	limit := 50 + rng.Intn(150)
	granted := 0
	events := []Event{{Op: OpLimit, Amount: limit}}

	for len(events) < numEvents {
		var options []func()

		var free, pending, held []int
		for i := range ids {
			switch state[i] {
			case sNone:
				free = append(free, i)
			case sPending:
				pending = append(pending, i)
			case sGranted:
				held = append(held, i)
			}
		}

		if len(free) > 0 && limit-granted > 0 {
			options = append(options, func() {
				i := free[rng.Intn(len(free))]
				max := limit - granted
				if max > 30 {
					max = 30
				}
				amount[i] = 1 + rng.Intn(max)
				state[i] = sPending
				events = append(events, Event{Op: OpApply, Ticket: ids[i], Amount: amount[i]})
			})
		}
		var grantable []int
		for _, i := range pending {
			if granted+amount[i] <= limit {
				grantable = append(grantable, i)
			}
		}
		if len(grantable) > 0 {
			options = append(options, func() {
				i := grantable[rng.Intn(len(grantable))]
				state[i] = sGranted
				granted += amount[i]
				events = append(events, Event{Op: OpGrant, Ticket: ids[i]})
			})
		}
		if len(pending) > 0 {
			options = append(options, func() {
				i := pending[rng.Intn(len(pending))]
				state[i] = sNone
				events = append(events, Event{Op: OpCancel, Ticket: ids[i]})
			})
		}
		if len(held) > 0 {
			options = append(options, func() {
				i := held[rng.Intn(len(held))]
				state[i] = sNone
				granted -= amount[i]
				events = append(events, Event{Op: OpRelease, Ticket: ids[i]})
			})
		}
		options = append(options, func() {
			limit = granted + rng.Intn(100)
			events = append(events, Event{Op: OpLimit, Amount: limit})
		})

		options[rng.Intn(len(options))]()
	}
	return events
}

// Corrupt applies a single-point, guaranteed-detectable corruption to a
// valid log: one event inserted, removed, or replaced. It returns the
// corrupted log and the error kind Check is expected to report.
func Corrupt(rng *rand.Rand, events []Event) ([]Event, string) {
	type strategy struct {
		kind  string
		apply func() []Event
	}
	var strategies []strategy

	// Duplicate a RELEASE: the copy is a duplicate-release error.
	if idxs := opIndices(events, OpRelease); len(idxs) > 0 {
		strategies = append(strategies, strategy{"duplicate-release", func() []Event {
			i := idxs[rng.Intn(len(idxs))]
			return insertAfter(events, i, events[i])
		}})
	}
	// Duplicate a GRANT: the copy hits an already-granted ticket.
	if idxs := opIndices(events, OpGrant); len(idxs) > 0 {
		strategies = append(strategies, strategy{"already-granted", func() []Event {
			i := idxs[rng.Intn(len(idxs))]
			return insertAfter(events, i, events[i])
		}})
		// Insert LIMIT 0 right after a grant: total granted exceeds the
		// limit now in force.
		strategies = append(strategies, strategy{"limit-exceeded", func() []Event {
			i := idxs[rng.Intn(len(idxs))]
			return insertAfter(events, i, Event{Op: OpLimit, Amount: 0})
		}})
	}
	// Drop a GRANT whose ticket is later released: the release then has
	// no grant behind it.
	if i, ok := droppableGrant(events); ok {
		strategies = append(strategies, strategy{"release-ungranted", func() []Event {
			out := make([]Event, 0, len(events)-1)
			out = append(out, events[:i]...)
			return append(out, events[i+1:]...)
		}})
	}
	// Replace a RELEASE with a CANCEL: cancel of a granted ticket.
	if idxs := opIndices(events, OpRelease); len(idxs) > 0 {
		strategies = append(strategies, strategy{"cancel-after-grant", func() []Event {
			out := append([]Event(nil), events...)
			i := idxs[rng.Intn(len(idxs))]
			out[i] = Event{Op: OpCancel, Ticket: events[i].Ticket}
			return out
		}})
	}

	if len(strategies) == 0 {
		return append([]Event(nil), events...), ""
	}
	s := strategies[rng.Intn(len(strategies))]
	return s.apply(), s.kind
}

func opIndices(events []Event, op Op) []int {
	var out []int
	for i, ev := range events {
		if ev.Op == op {
			out = append(out, i)
		}
	}
	return out
}

func insertAfter(events []Event, i int, ev Event) []Event {
	out := make([]Event, 0, len(events)+1)
	out = append(out, events[:i+1]...)
	out = append(out, ev)
	return append(out, events[i+1:]...)
}

// droppableGrant finds a GRANT whose ticket's next same-ticket event is a
// RELEASE (so removing the grant strands the release).
func droppableGrant(events []Event) (int, bool) {
	for i, ev := range events {
		if ev.Op != OpGrant {
			continue
		}
		for j := i + 1; j < len(events); j++ {
			if events[j].Ticket != ev.Ticket {
				continue
			}
			if events[j].Op == OpRelease {
				return i, true
			}
			break
		}
	}
	return 0, false
}
