package forward

import "context"

// Sink consumes the chunk stream for one destination.
type Sink interface {
	// WriteChunk delivers one chunk. data aliases the shared leased
	// buffer and is valid only for the duration of the call; copy it to
	// retain it. Implementations must honor ctx cancellation so a
	// canceled Forward cannot block forever.
	WriteChunk(ctx context.Context, data []byte) error
	// Close is called exactly once after the last WriteChunk, with the
	// terminal error (nil on clean delivery). Forward returns only after
	// every sink's Close has returned.
	Close(err error) error
}

// Namer lets a sink identify itself in DestStats and wrapped errors.
type Namer interface{ Name() string }
