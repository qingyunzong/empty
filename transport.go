package comm

import (
	"context"
	"errors"
)

// Transport carries a message to the receiver and returns its ack.
type Transport interface {
	Send(ctx context.Context, msg Message) (Ack, error)
}

// DirectTransport is a fault-free in-process transport.
type DirectTransport struct {
	Receiver *Receiver
}

func (d DirectTransport) Send(ctx context.Context, msg Message) (Ack, error) {
	return d.Receiver.Receive(msg)
}

// FlakyTransport injects network faults: requests can be lost before
// reaching the receiver, and acks can be lost after the receiver has
// already persisted the effect.
type FlakyTransport struct {
	Receiver    *Receiver
	DropRequest func() bool // message lost in transit
	DropAck     func() bool // receiver processed it, ack lost on the way back
}

var (
	errRequestLost = errors.New("network: request lost")
	errAckLost     = errors.New("network: ack lost")
)

func (f *FlakyTransport) Send(ctx context.Context, msg Message) (Ack, error) {
	if f.DropRequest != nil && f.DropRequest() {
		return Ack{}, errRequestLost
	}
	ack, err := f.Receiver.Receive(msg)
	if err != nil {
		return Ack{}, err
	}
	if f.DropAck != nil && f.DropAck() {
		// The effect is already persisted; the sender will retry and
		// must get a duplicate ack instead of a second effect.
		return Ack{}, errAckLost
	}
	return ack, nil
}
