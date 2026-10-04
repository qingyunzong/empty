package orderstats

import "time"

// State is an order lifecycle state.
type State string

const (
	StateNone      State = ""
	StateCreated   State = "created"
	StatePaid      State = "paid"
	StatePacked    State = "packed"
	StateShipped   State = "shipped"
	StateDelivered State = "delivered"
	StateCancelled State = "cancelled"
	StateReturned  State = "returned"
)

// Event is a single order state-transition observation. Events sharing
// an ID are versions of one another: a higher Version is a correction
// that supersedes the lower one.
type Event struct {
	ID      string
	Order   string
	Time    time.Time
	Version int
	To      State
}

// lessEvent orders events by time, breaking ties by version then ID.
func lessEvent(a, b Event) bool {
	if !a.Time.Equal(b.Time) {
		return a.Time.Before(b.Time)
	}
	if a.Version != b.Version {
		return a.Version < b.Version
	}
	return a.ID < b.ID
}
