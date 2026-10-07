package resub

import (
	"context"
	"errors"
)

// ErrDisconnected indicates the connection was lost. The subscriber
// reconnects and redelivery resumes from the last confirmed sequence number.
var ErrDisconnected = errors.New("resub: connection disconnected")

// ErrStaleGeneration indicates the connection belongs to a superseded
// generation and must not be used: a new generation cancels old connections.
var ErrStaleGeneration = errors.New("resub: stale generation")

// Transport dials a subscription stream. from is the last confirmed sequence
// number; the server must stream events strictly after from. gen identifies
// the connection generation: opening a new generation supersedes (cancels)
// every older connection.
type Transport interface {
	Connect(ctx context.Context, from uint64, gen uint64) (Conn, error)
}

// Conn is one generation of the subscription stream.
type Conn interface {
	// Recv returns the next event. io.EOF means the stream is complete;
	// any other error means the connection is lost.
	Recv(ctx context.Context) (Event, error)
	Close() error
}
