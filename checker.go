package ticketlog

import (
	"fmt"
	"sort"
	"strings"
)

// ChainEntry is one step of a causal chain: an event plus why it matters.
type ChainEntry struct {
	Event Event
	Note  string
}

// Error describes the first rule violation found in a log, together with
// the full causal chain of events that led to it.
type Error struct {
	Event   Event        // the offending event
	Kind    string       // machine-readable category
	Message string       // human-readable explanation
	Chain   []ChainEntry // ordered causal chain ending at the offending event
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s: %s", e.Event, e.Message)
}

// Detail renders the error and its causal chain.
func (e *Error) Detail() string {
	var b strings.Builder
	fmt.Fprintf(&b, "first error (%s) at %s: %s\n", e.Kind, e.Event, e.Message)
	b.WriteString("causal chain:\n")
	for _, ce := range e.Chain {
		fmt.Fprintf(&b, "  %-22s %s\n", ce.Event, ce.Note)
	}
	return b.String()
}

type genState int

const (
	stateNone    genState = iota // no active generation
	statePending                 // applied, not yet granted
	stateGranted                 // granted, holding units
)

// generation is one lifetime of a ticket: APPLY -> GRANT -> RELEASE, or
// APPLY -> CANCEL. A ticket id may be reused; each APPLY opens a new
// generation with fresh state.
type generation struct {
	number  int
	amount  int
	state   genState
	apply   *Event
	grant   *Event
	release *Event
	cancel  *Event
}

type ticket struct {
	cur  generation
	prev []generation // closed generations, oldest first
}

func (t *ticket) closeGen() {
	if t.cur.apply != nil {
		t.prev = append(t.prev, t.cur)
	}
	t.cur = generation{number: t.cur.number + 1}
}

type checker struct {
	limit      int
	limitEvent *Event
	granted    int
	tickets    map[string]*ticket
}

// Check replays the log and returns the first rule violation, or nil if
// the log is valid. Rules:
//
//   - state is rebuilt per ticket generation (APPLY opens a new one);
//   - CANCEL of an ungranted ticket frees nothing;
//   - a duplicate (or otherwise ungrounded) RELEASE is an error;
//   - total granted units never exceed the limit in force at that moment.
func Check(events []Event) *Error {
	c := &checker{tickets: map[string]*ticket{}}
	for i := range events {
		events[i].Seq = i + 1
		if err := c.step(&events[i]); err != nil {
			return err
		}
	}
	return nil
}

func (c *checker) ticketFor(id string) *ticket {
	t, ok := c.tickets[id]
	if !ok {
		t = &ticket{}
		c.tickets[id] = t
	}
	return t
}

func (c *checker) step(ev *Event) *Error {
	switch ev.Op {
	case OpLimit:
		if ev.Amount < 0 {
			return &Error{Event: *ev, Kind: "invalid-amount",
				Message: fmt.Sprintf("negative limit %d", ev.Amount),
				Chain:   []ChainEntry{{*ev, "negative limit"}}}
		}
		c.limit = ev.Amount
		c.limitEvent = ev
		if c.granted > c.limit {
			return c.overflowError(*ev, "limit lowered below in-flight grants")
		}

	case OpApply:
		if ev.Ticket == "" || ev.Amount <= 0 {
			return &Error{Event: *ev, Kind: "invalid-amount",
				Message: fmt.Sprintf("application needs a ticket and a positive amount, got %q/%d", ev.Ticket, ev.Amount),
				Chain:   []ChainEntry{{*ev, "invalid application"}}}
		}
		t := c.ticketFor(ev.Ticket)
		if t.cur.state != stateNone {
			e := &Error{Event: *ev, Kind: "apply-while-active",
				Message: fmt.Sprintf("ticket %s already has an active generation %d", ev.Ticket, t.cur.number)}
			e.Chain = append(e.Chain, c.genEntries(t.cur)...)
			e.Chain = append(e.Chain, ChainEntry{*ev, "new application while previous generation still active"})
			return e
		}
		t.closeGen()
		t.cur.amount = ev.Amount
		t.cur.state = statePending
		t.cur.apply = ev

	case OpGrant:
		t := c.ticketFor(ev.Ticket)
		switch t.cur.state {
		case stateNone:
			e := &Error{Event: *ev, Kind: "grant-without-apply",
				Message: fmt.Sprintf("ticket %s has no pending application", ev.Ticket)}
			e.Chain = append(e.Chain, c.historyEntries(t)...)
			e.Chain = append(e.Chain, ChainEntry{*ev, "grant without a pending application"})
			return e
		case stateGranted:
			e := &Error{Event: *ev, Kind: "already-granted",
				Message: fmt.Sprintf("ticket %s is already granted in generation %d", ev.Ticket, t.cur.number)}
			e.Chain = append(e.Chain, c.genEntries(t.cur)...)
			e.Chain = append(e.Chain, ChainEntry{*ev, "duplicate grant"})
			return e
		}
		t.cur.state = stateGranted
		t.cur.grant = ev
		c.granted += t.cur.amount
		if c.granted > c.limit {
			return c.overflowError(*ev, "grant pushes total over the limit")
		}

	case OpCancel:
		t := c.ticketFor(ev.Ticket)
		switch t.cur.state {
		case stateNone:
			e := &Error{Event: *ev, Kind: "cancel-without-apply",
				Message: fmt.Sprintf("ticket %s has no pending application to cancel", ev.Ticket)}
			e.Chain = append(e.Chain, c.historyEntries(t)...)
			e.Chain = append(e.Chain, ChainEntry{*ev, "cancel without a pending application"})
			return e
		case stateGranted:
			e := &Error{Event: *ev, Kind: "cancel-after-grant",
				Message: fmt.Sprintf("ticket %s is granted; it must be released, not cancelled", ev.Ticket)}
			e.Chain = append(e.Chain, c.genEntries(t.cur)...)
			e.Chain = append(e.Chain, ChainEntry{*ev, "cancel of a granted ticket"})
			return e
		}
		// Cancel of an ungranted ticket: closes the generation and frees
		// nothing — no units were ever handed out.
		t.cur.cancel = ev
		t.closeGen()

	case OpRelease:
		t := c.ticketFor(ev.Ticket)
		switch t.cur.state {
		case stateGranted:
			t.cur.release = ev
			c.granted -= t.cur.amount
			t.closeGen()
		case statePending:
			e := &Error{Event: *ev, Kind: "release-ungranted",
				Message: fmt.Sprintf("ticket %s was applied but never granted; nothing to release", ev.Ticket)}
			e.Chain = append(e.Chain, c.genEntries(t.cur)...)
			e.Chain = append(e.Chain, ChainEntry{*ev, "release of an ungranted ticket"})
			return e
		default: // stateNone
			return c.ungroundedRelease(ev, t)
		}
	}
	return nil
}

// ungroundedRelease classifies a RELEASE with no active generation:
// duplicate release, release after cancel, or release out of nowhere.
func (c *checker) ungroundedRelease(ev *Event, t *ticket) *Error {
	e := &Error{Event: *ev, Kind: "release-without-grant",
		Message: fmt.Sprintf("ticket %s has no active grant", ev.Ticket)}
	if n := len(t.prev); n > 0 {
		last := t.prev[n-1]
		switch {
		case last.release != nil:
			e.Kind = "duplicate-release"
			e.Message = fmt.Sprintf("ticket %s generation %d was already released", ev.Ticket, last.number)
			e.Chain = append(e.Chain, c.genEntries(last)...)
			e.Chain = append(e.Chain, ChainEntry{*ev, "second release of the same generation"})
			return e
		case last.cancel != nil:
			e.Kind = "release-after-cancel"
			e.Message = fmt.Sprintf("ticket %s generation %d was cancelled, never granted", ev.Ticket, last.number)
			e.Chain = append(e.Chain, c.genEntries(last)...)
			e.Chain = append(e.Chain, ChainEntry{*ev, "release of a cancelled application"})
			return e
		}
	}
	e.Chain = append(e.Chain, ChainEntry{*ev, "release without any grant"})
	return e
}

// overflowError builds the limit-exceeded error with the full causal chain:
// the limit in force, every grant currently holding units, and the
// offending event.
func (c *checker) overflowError(ev Event, note string) *Error {
	e := &Error{Event: ev, Kind: "limit-exceeded",
		Message: fmt.Sprintf("total granted %d exceeds current limit %d", c.granted, c.limit)}
	if c.limitEvent != nil {
		e.Chain = append(e.Chain, ChainEntry{*c.limitEvent, fmt.Sprintf("limit in force: %d", c.limit)})
	}
	ids := make([]string, 0, len(c.tickets))
	for id := range c.tickets {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		t := c.tickets[id]
		if t.cur.state != stateGranted {
			continue
		}
		if t.cur.apply != nil {
			e.Chain = append(e.Chain, ChainEntry{*t.cur.apply,
				fmt.Sprintf("generation %d requests %d units", t.cur.number, t.cur.amount)})
		}
		if t.cur.grant != nil && t.cur.grant.Seq != ev.Seq {
			e.Chain = append(e.Chain, ChainEntry{*t.cur.grant,
				fmt.Sprintf("granted %d units, still held", t.cur.amount)})
		}
	}
	e.Chain = append(e.Chain, ChainEntry{ev, fmt.Sprintf("%s: total %d > limit %d", note, c.granted, c.limit)})
	sort.SliceStable(e.Chain, func(i, j int) bool { return e.Chain[i].Event.Seq < e.Chain[j].Event.Seq })
	return e
}

// genEntries renders the recorded events of one generation.
func (c *checker) genEntries(g generation) []ChainEntry {
	var out []ChainEntry
	if g.apply != nil {
		out = append(out, ChainEntry{*g.apply, fmt.Sprintf("generation %d opened for %d units", g.number, g.amount)})
	}
	if g.grant != nil {
		out = append(out, ChainEntry{*g.grant, fmt.Sprintf("granted %d units", g.amount)})
	}
	if g.cancel != nil {
		out = append(out, ChainEntry{*g.cancel, "application cancelled; nothing was granted, nothing freed"})
	}
	if g.release != nil {
		out = append(out, ChainEntry{*g.release, fmt.Sprintf("released %d units; generation closed", g.amount)})
	}
	return out
}

// historyEntries renders the most recent closed generation, if any.
func (c *checker) historyEntries(t *ticket) []ChainEntry {
	if n := len(t.prev); n > 0 {
		return c.genEntries(t.prev[n-1])
	}
	return nil
}
