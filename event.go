package resub

import "context"

// Event is one delivered message. ID is the stable result ID: redeliveries of
// the same logical result always carry the same ID, so consumers can
// deduplicate idempotently.
type Event struct {
	Seq     uint64
	ID      string
	Payload []byte
}

// Callback processes a delivered event. The event is confirmed only if the
// callback returns nil; a non-nil error leaves the event unconfirmed and
// schedules a redelivery.
type Callback func(ctx context.Context, ev Event) error
