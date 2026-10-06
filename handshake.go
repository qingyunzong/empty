// Package handshake implements a custom message state machine that processes
// clienthello, serverhello and finish messages in strict phase order.
//
// Semantics:
//   - Messages must arrive in phase order: clienthello -> serverhello -> finish.
//   - Duplicate messages of the same generation are idempotent (accepted
//     silently, no state change, no side effects).
//   - Messages that skip a phase or carry a different generation are rejected.
//   - Authentication runs asynchronously once finish is received and is
//     cancellable through the machine's context.
//   - The wrapped connection is delivered (via WaitConn) only after finish
//     authentication succeeds. Cancellation and late authentication results
//     never leak the connection.
package handshake

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
)

// MsgType identifies a handshake message kind.
type MsgType uint8

const (
	MsgClientHello MsgType = iota + 1
	MsgServerHello
	MsgFinish
)

// order returns the message's position in the handshake sequence.
func (t MsgType) order() int {
	switch t {
	case MsgClientHello:
		return 1
	case MsgServerHello:
		return 2
	case MsgFinish:
		return 3
	}
	return 0
}

func (t MsgType) String() string {
	switch t {
	case MsgClientHello:
		return "clienthello"
	case MsgServerHello:
		return "serverhello"
	case MsgFinish:
		return "finish"
	}
	return fmt.Sprintf("unknown(%d)", uint8(t))
}

// Phase is the state machine's current stage.
type Phase int

const (
	PhaseInit Phase = iota
	PhaseClientHello
	PhaseServerHello
	PhaseFinish
)

func (p Phase) String() string {
	switch p {
	case PhaseInit:
		return "init"
	case PhaseClientHello:
		return "clienthello"
	case PhaseServerHello:
		return "serverhello"
	case PhaseFinish:
		return "finish"
	}
	return fmt.Sprintf("phase(%d)", int(p))
}

// Message is a single handshake message. All messages of one handshake run
// share the same Generation; retransmitted duplicates keep the generation.
type Message struct {
	Type       MsgType
	Generation uint64
	Payload    []byte
}

var (
	// ErrOutOfPhase is returned when a message skips ahead of the current phase.
	ErrOutOfPhase = errors.New("handshake: message out of phase")
	// ErrGenerationMismatch is returned when a message carries a generation
	// different from the one that opened the handshake.
	ErrGenerationMismatch = errors.New("handshake: generation mismatch")
	// ErrClosed is returned when the machine has been closed.
	ErrClosed = errors.New("handshake: closed")
	// ErrAlreadyDelivered is returned by WaitConn when the connection has
	// already been handed out.
	ErrAlreadyDelivered = errors.New("handshake: connection already delivered")
)

// AuthInfo carries the collected handshake material to the Authenticator.
type AuthInfo struct {
	Generation         uint64
	ClientHelloPayload []byte
	ServerHelloPayload []byte
	FinishPayload      []byte
}

// Authenticator verifies the peer asynchronously. The supplied context is
// cancelled when the machine is closed; implementations must honor it.
type Authenticator interface {
	Authenticate(ctx context.Context, info AuthInfo) error
}

// AuthenticatorFunc adapts a function to Authenticator.
type AuthenticatorFunc func(ctx context.Context, info AuthInfo) error

// Authenticate implements Authenticator.
func (f AuthenticatorFunc) Authenticate(ctx context.Context, info AuthInfo) error {
	return f(ctx, info)
}

// Machine drives one handshake over conn. The zero value is not usable;
// construct with NewMachine.
type Machine struct {
	conn net.Conn
	auth Authenticator

	ctx    context.Context
	cancel context.CancelFunc

	mu        sync.Mutex
	cond      *sync.Cond
	phase     Phase
	gen       uint64
	genSet    bool
	info      AuthInfo
	authDone  chan struct{} // closed when authentication completes
	authErr   error
	closed    bool
	delivered bool
}

// NewMachine creates a state machine wrapping conn. The connection is only
// exposed to callers after a successful finish authentication.
func NewMachine(conn net.Conn, auth Authenticator) *Machine {
	ctx, cancel := context.WithCancel(context.Background())
	m := &Machine{conn: conn, auth: auth, ctx: ctx, cancel: cancel}
	m.cond = sync.NewCond(&m.mu)
	return m
}

// Phase returns the machine's current phase.
func (m *Machine) Phase() Phase {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.phase
}

// HandleMessage processes one inbound handshake message.
//
// A message whose order is at or below the current phase is a same-generation
// retransmission and is idempotently accepted. A message exactly one step
// ahead advances the state machine. Anything further ahead is rejected with
// ErrOutOfPhase. A generation other than the one that opened the handshake is
// rejected with ErrGenerationMismatch.
func (m *Machine) HandleMessage(msg Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.closed {
		return ErrClosed
	}
	if msg.Type.order() == 0 {
		return fmt.Errorf("handshake: unknown message type %d", uint8(msg.Type))
	}
	if m.genSet && msg.Generation != m.gen {
		return fmt.Errorf("%w: got %d, want %d", ErrGenerationMismatch, msg.Generation, m.gen)
	}

	msgOrd := msg.Type.order()
	phaseOrd := int(m.phase)

	switch {
	case msgOrd <= phaseOrd:
		// Same-generation retransmission of an already consumed message:
		// idempotent, no state change, no side effects.
		return nil
	case msgOrd > phaseOrd+1:
		return fmt.Errorf("%w: %s cannot follow phase %s", ErrOutOfPhase, msg.Type, m.phase)
	}

	switch msg.Type {
	case MsgClientHello:
		m.gen = msg.Generation
		m.genSet = true
		m.info.Generation = msg.Generation
		m.info.ClientHelloPayload = append([]byte(nil), msg.Payload...)
		m.phase = PhaseClientHello
	case MsgServerHello:
		m.info.ServerHelloPayload = append([]byte(nil), msg.Payload...)
		m.phase = PhaseServerHello
	case MsgFinish:
		m.info.FinishPayload = append([]byte(nil), msg.Payload...)
		m.phase = PhaseFinish
		m.startAuthLocked()
	}
	m.cond.Broadcast()
	return nil
}

// startAuthLocked launches asynchronous authentication for the accepted
// finish message. The result is published by closing authDone, so any number
// of WaitConn callers can observe it; if the machine is closed first, the
// late result is discarded instead of leaking.
func (m *Machine) startAuthLocked() {
	m.authDone = make(chan struct{})
	info := m.info
	go func() {
		err := m.auth.Authenticate(m.ctx, info)
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.closed {
			// Barrier: machine closed while authenticating; drop the
			// late result so it can never leak a delivered connection.
			return
		}
		m.authErr = err
		if err != nil && !m.delivered {
			// Authentication failed: the connection must never be
			// delivered, so close it.
			m.conn.Close()
		}
		close(m.authDone)
		m.cond.Broadcast()
	}()
}

// WaitConn blocks until finish authentication succeeds and then returns the
// wrapped connection. It returns an error if authentication fails, the caller's
// context is cancelled, or the machine is closed. Only the first successful
// caller receives the connection.
func (m *Machine) WaitConn(ctx context.Context) (net.Conn, error) {
	m.mu.Lock()
	for m.authDone == nil && !m.closed {
		m.cond.Wait()
	}
	done := m.authDone
	if done == nil {
		m.mu.Unlock()
		return nil, ErrClosed
	}
	m.mu.Unlock()

	select {
	case <-done:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-m.ctx.Done():
		return nil, ErrClosed
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.authErr != nil {
		return nil, fmt.Errorf("handshake: authentication failed: %w", m.authErr)
	}
	if m.closed {
		return nil, ErrClosed
	}
	if m.delivered {
		return nil, ErrAlreadyDelivered
	}
	m.delivered = true
	return m.conn, nil
}

// Close cancels any in-flight authentication and closes the wrapped
// connection unless it has already been delivered. Late authentication
// results arriving after Close are discarded.
func (m *Machine) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ErrClosed
	}
	m.closed = true
	m.cancel()
	m.cond.Broadcast()
	delivered := m.delivered
	m.mu.Unlock()

	if !delivered {
		return m.conn.Close()
	}
	return nil
}
