package commlib

import (
	"errors"
	"sync"
)

// ErrNetwork is returned when the transport cannot carry a message or its ack.
var ErrNetwork = errors.New("commlib: network unavailable")

// Transport carries a message to the receiver and returns its ack.
type Transport interface {
	Send(msg Message) (Ack, error)
}

// DirectTransport delivers synchronously to a local receiver.
type DirectTransport struct {
	R *Receiver
}

func (d DirectTransport) Send(msg Message) (Ack, error) {
	return d.R.Receive(msg)
}

// FlakyTransport wraps a Transport and injects network faults: partitions,
// lost requests (message never arrives) and lost acks (message arrives and
// is applied, but the sender never learns — forcing retransmission).
type FlakyTransport struct {
	inner Transport

	mu        sync.Mutex
	partition bool
	dropNext  int
	loseAcks  int
}

func NewFlakyTransport(inner Transport) *FlakyTransport {
	return &FlakyTransport{inner: inner}
}

// SetPartition cuts (on=true) or restores (on=false) the link.
func (f *FlakyTransport) SetPartition(on bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.partition = on
}

// DropNextRequests loses the next n outbound messages in flight.
func (f *FlakyTransport) DropNextRequests(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dropNext += n
}

// LoseNextAcks delivers the next n messages but loses their acks.
func (f *FlakyTransport) LoseNextAcks(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loseAcks += n
}

func (f *FlakyTransport) Send(msg Message) (Ack, error) {
	f.mu.Lock()
	if f.partition {
		f.mu.Unlock()
		return Ack{}, ErrNetwork
	}
	if f.dropNext > 0 {
		f.dropNext--
		f.mu.Unlock()
		return Ack{}, ErrNetwork
	}
	loseAck := f.loseAcks > 0
	if loseAck {
		f.loseAcks--
	}
	f.mu.Unlock()

	ack, err := f.inner.Send(msg)
	if err != nil {
		return Ack{}, err
	}
	if loseAck {
		return Ack{}, ErrNetwork
	}
	return ack, nil
}
