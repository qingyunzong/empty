// Package orderstats builds per-order state timelines from order events.
//
// Events are ordered by (Timestamp, Version, ID). Illegal transitions are
// rejected with the offending event kept as evidence and never take effect.
// A correction (an event whose ID matches an existing event but carries a
// higher Version) supersedes the earlier event and may change the legality
// of subsequent events, so the affected timeline is rebuilt by full replay.
package orderstats

import "time"

// State is an order lifecycle state.
type State string

const (
	StateNone      State = ""
	StateCreated   State = "created"
	StatePaid      State = "paid"
	StateShipped   State = "shipped"
	StateDelivered State = "delivered"
	StateCancelled State = "cancelled"
)

// transitions lists the legal successors of each state. StateNone is the
// implicit state of an order before its first event.
var transitions = map[State]map[State]bool{
	StateNone:    {StateCreated: true},
	StateCreated: {StatePaid: true, StateCancelled: true},
	StatePaid:    {StateShipped: true, StateCancelled: true},
	StateShipped: {StateDelivered: true},
}

// Legal reports whether moving from state `from` to state `to` is allowed.
func Legal(from, to State) bool {
	return transitions[from][to]
}

// Event is a single order state-transition observation. An event with the
// same ID but a higher Version than a previously seen event is a correction
// and supersedes it.
type Event struct {
	ID        string
	OrderID   string
	Version   int
	Timestamp time.Time
	To        State
}

// Rejection is the evidence recorded when an event does not take effect.
type Rejection struct {
	Event   Event
	Current State // order state at the moment the event was attempted
	Reason  string
}
