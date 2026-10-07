// Package handshake implements a custom message state machine that drives a
// connection through clienthello, serverhello and finish phases, runs
// asynchronous cancellable authentication on finish, and only delivers the
// connection to the caller after authentication succeeds.
//
// Semantics:
//   - Messages carry a generation. Messages from any other generation than
//     the session's current one are rejected (ErrStaleGeneration).
//   - Receiving the same message twice within one generation is idempotent:
//     it is acknowledged without side effects.
//   - Messages that skip a phase are rejected (ErrOutOfPhase).
//   - Authentication runs asynchronously and is cancelled by Cancel or Reset.
//   - The connection is delivered via Wait only after finish authentication
//     succeeds. A barrier guarantees that cancellation and late authentication
//     results never deliver or leak the connection.
package handshake

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
)

// MessageType identifies a handshake message kind.
type MessageType int

const (
	MessageClientHello MessageType = iota
	MessageServerHello
	MessageFinish
)

func (t MessageType) String() string {
	switch t {
	case MessageClientHello:
		return "clienthello"
	case MessageServerHello:
		return "serverhello"
	case MessageFinish:
		return "finish"
	}
	return fmt.Sprintf("unknown(%d)", int(t))
}

// Message is a single handshake message. Generation identifies the handshake
// generation the message belongs to; Payload is opaque to the state machine
// and forwarded to the Authenticator.
type Message struct {
	Type       MessageType
	Generation uint64
	Payload    []byte
}

var (
	// ErrOutOfPhase is returned when a message skips ahead of the current
	// state machine phase.
	ErrOutOfPhase = errors.New("handshake: message out of phase")
	// ErrStaleGeneration is returned when a message belongs to a different
	// generation than the session's current one.
	ErrStaleGeneration = errors.New("handshake: generation mismatch")
	// ErrUnknownMessage is returned for an unrecognised message type.
	ErrUnknownMessage = errors.New("handshake: unknown message type")
	// ErrCancelled is delivered by Wait when the session is cancelled.
	ErrCancelled = errors.New("handshake: cancelled")
)

// AuthRequest carries the collected handshake payloads to the Authenticator.
type AuthRequest struct {
	Generation  uint64
	ClientHello []byte
	ServerHello []byte
	Finish      []byte
}

// AuthResult is the outcome of a successful authentication.
type AuthResult struct {
	PeerID string
}

// Authenticator performs asynchronous, cancellable authentication. It must
// honour ctx cancellation; the session never blocks on a result after the
// context is cancelled.
type Authenticator interface {
	Authenticate(ctx context.Context, req AuthRequest) (AuthResult, error)
}

// AuthenticatorFunc adapts a function to Authenticator.
type AuthenticatorFunc func(ctx context.Context, req AuthRequest) (AuthResult, error)

// Authenticate implements Authenticator.
func (f AuthenticatorFunc) Authenticate(ctx context.Context, req AuthRequest) (AuthResult, error) {
	return f(ctx, req)
}

// Conn is the connection delivered after a successful handshake.
type Conn struct {
	net.Conn
	Auth       AuthResult
	Generation uint64
}

type phase int

const (
	phaseInit phase = iota
	phaseClientHello
	phaseServerHello
	phaseAuthenticating
	phaseEstablished
	phaseFailed
)

// step returns how far the state machine has advanced: 0 = init,
// 1 = clienthello, 2 = serverhello, 3 = finish (authenticating or beyond).
func (p phase) step() int {
	switch p {
	case phaseInit:
		return 0
	case phaseClientHello:
		return 1
	case phaseServerHello:
		return 2
	default:
		return 3
	}
}

func stepOf(t MessageType) (int, error) {
	switch t {
	case MessageClientHello:
		return 1, nil
	case MessageServerHello:
		return 2, nil
	case MessageFinish:
		return 3, nil
	}
	return 0, fmt.Errorf("%w: %d", ErrUnknownMessage, int(t))
}

// Session is a single handshake state machine. It is safe for concurrent use.
type Session struct {
	mu   sync.Mutex
	auth Authenticator
	conn net.Conn

	phase       phase
	gen         uint64
	hello       []byte
	serverHello []byte

	cancel context.CancelFunc // cancels the in-flight authentication
	done   chan struct{}      // closed when the generation reaches a terminal phase
	result *Conn
	err    error

	wg sync.WaitGroup // tracks in-flight authentication goroutines
}

// NewSession creates a session guarding conn. The connection is delivered via
// Wait only after finish authentication succeeds; on failure or cancellation
// it is closed instead. The initial generation is 0.
func NewSession(conn net.Conn, auth Authenticator) *Session {
	return &Session{
		auth:  auth,
		conn:  conn,
		phase: phaseInit,
		done:  make(chan struct{}),
	}
}

// Generation returns the session's current handshake generation.
func (s *Session) Generation() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gen
}

// Done returns a channel closed when the current generation reaches a
// terminal state (established or failed).
func (s *Session) Done() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.done
}

// HandleMessage feeds one message into the state machine.
//
// Duplicate messages of the current generation are idempotent no-ops.
// Messages that skip a phase are rejected with ErrOutOfPhase; messages from
// another generation are rejected with ErrStaleGeneration.
func (s *Session) HandleMessage(m Message) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.phase == phaseFailed {
		return s.err
	}
	if m.Generation != s.gen {
		return fmt.Errorf("%w: got %d, current %d", ErrStaleGeneration, m.Generation, s.gen)
	}
	step, err := stepOf(m.Type)
	if err != nil {
		return err
	}
	cur := s.phase.step()
	switch {
	case step <= cur:
		// Retransmission within the same generation: idempotent.
		return nil
	case step > cur+1:
		return fmt.Errorf("%w: %s cannot follow phase %d", ErrOutOfPhase, m.Type, s.phase.step())
	}

	switch m.Type {
	case MessageClientHello:
		s.hello = append([]byte(nil), m.Payload...)
		s.phase = phaseClientHello
	case MessageServerHello:
		s.serverHello = append([]byte(nil), m.Payload...)
		s.phase = phaseServerHello
	case MessageFinish:
		s.phase = phaseAuthenticating
		s.startAuthLocked(m.Payload)
	}
	return nil
}

// startAuthLocked launches asynchronous authentication for the current
// generation. s.mu must be held.
func (s *Session) startAuthLocked(finishPayload []byte) {
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	req := AuthRequest{
		Generation:  s.gen,
		ClientHello: append([]byte(nil), s.hello...),
		ServerHello: append([]byte(nil), s.serverHello...),
		Finish:      append([]byte(nil), finishPayload...),
	}
	gen := s.gen
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		res, err := s.auth.Authenticate(ctx, req)
		s.complete(gen, res, err)
	}()
}

// complete is the delivery barrier: it accepts an authentication result only
// if the session is still authenticating in the same generation. Late results
// arriving after Cancel or Reset are dropped and can never deliver the
// connection.
func (s *Session) complete(gen uint64, res AuthResult, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.phase != phaseAuthenticating || gen != s.gen {
		return
	}
	if err != nil {
		s.failLocked(err)
		return
	}
	s.phase = phaseEstablished
	s.result = &Conn{Conn: s.conn, Auth: res, Generation: gen}
	close(s.done)
}

// Cancel aborts the handshake, cancels any in-flight authentication and
// closes the guarded connection. It is idempotent.
func (s *Session) Cancel() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.phase == phaseEstablished || s.phase == phaseFailed {
		return
	}
	s.failLocked(ErrCancelled)
}

// failLocked moves the session to the terminal failed phase, cancels
// in-flight authentication and closes the connection. s.mu must be held.
func (s *Session) failLocked(err error) {
	s.phase = phaseFailed
	s.err = err
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	close(s.done)
	if s.conn != nil {
		s.conn.Close()
	}
}

// Reset aborts any in-flight authentication and restarts the state machine at
// the init phase with a new generation. Late authentication results from the
// previous generation are dropped by the barrier. If the previous generation
// was established, the already delivered connection is left to its owner.
func (s *Session) Reset(generation uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	if s.phase != phaseEstablished && s.conn != nil {
		s.conn.Close()
	}
	s.phase = phaseInit
	s.gen = generation
	s.hello = nil
	s.serverHello = nil
	s.done = make(chan struct{})
	s.result = nil
	s.err = nil
}

// Wait blocks until the current generation reaches a terminal state and
// returns the delivered connection on success. It returns the session error
// (authentication failure or ErrCancelled) otherwise, or ctx.Err() if ctx is
// done first.
func (s *Session) Wait(ctx context.Context) (*Conn, error) {
	s.mu.Lock()
	done := s.done
	s.mu.Unlock()
	select {
	case <-done:
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.result != nil {
			return s.result, nil
		}
		return nil, s.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// WaitAuthDone blocks until all in-flight authentication goroutines have
// exited. It is intended for tests and orderly shutdown verification.
func (s *Session) WaitAuthDone() {
	s.wg.Wait()
}
