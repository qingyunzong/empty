package handshake_test

import (
	"context"
	"errors"
	"net"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"handshake"
)

const testTimeout = 5 * time.Second

func okAuth(peerID string) handshake.Authenticator {
	return handshake.AuthenticatorFunc(func(ctx context.Context, req handshake.AuthRequest) (handshake.AuthResult, error) {
		return handshake.AuthResult{PeerID: peerID}, nil
	})
}

func driveToFinish(t *testing.T, s *handshake.Session, gen uint64) {
	t.Helper()
	if err := s.HandleMessage(handshake.Message{Type: handshake.MessageClientHello, Generation: gen, Payload: []byte("ch")}); err != nil {
		t.Fatalf("clienthello: %v", err)
	}
	if err := s.HandleMessage(handshake.Message{Type: handshake.MessageServerHello, Generation: gen, Payload: []byte("sh")}); err != nil {
		t.Fatalf("serverhello: %v", err)
	}
	if err := s.HandleMessage(handshake.Message{Type: handshake.MessageFinish, Generation: gen, Payload: []byte("fin")}); err != nil {
		t.Fatalf("finish: %v", err)
	}
}

func TestHappyPathDeliversConnAfterAuth(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c2.Close()
	s := handshake.NewSession(c1, okAuth("peer-1"))

	driveToFinish(t, s, 0)

	conn, err := s.Wait(context.Background())
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if conn.Auth.PeerID != "peer-1" {
		t.Fatalf("unexpected peer: %q", conn.Auth.PeerID)
	}
	if conn.Generation != 0 {
		t.Fatalf("unexpected generation: %d", conn.Generation)
	}
	// The delivered connection is usable. net.Pipe is synchronous, so the
	// write runs concurrently with the peer read.
	writeErr := make(chan error, 1)
	go func() {
		_, err := conn.Write([]byte("ping"))
		writeErr <- err
	}()
	buf := make([]byte, 4)
	if _, err := c2.Read(buf); err != nil || string(buf) != "ping" {
		t.Fatalf("read on peer: %v %q", err, buf)
	}
	if err := <-writeErr; err != nil {
		t.Fatalf("write on delivered conn: %v", err)
	}
	s.WaitAuthDone()
}

func TestDuplicateSameGenerationMessagesAreIdempotent(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c2.Close()
	var calls atomic.Int32
	auth := handshake.AuthenticatorFunc(func(ctx context.Context, req handshake.AuthRequest) (handshake.AuthResult, error) {
		calls.Add(1)
		return handshake.AuthResult{PeerID: "p"}, nil
	})
	s := handshake.NewSession(c1, auth)

	for i := 0; i < 3; i++ {
		if err := s.HandleMessage(handshake.Message{Type: handshake.MessageClientHello, Generation: 0}); err != nil {
			t.Fatalf("dup clienthello #%d: %v", i, err)
		}
	}
	for i := 0; i < 3; i++ {
		if err := s.HandleMessage(handshake.Message{Type: handshake.MessageServerHello, Generation: 0}); err != nil {
			t.Fatalf("dup serverhello #%d: %v", i, err)
		}
	}
	for i := 0; i < 3; i++ {
		if err := s.HandleMessage(handshake.Message{Type: handshake.MessageFinish, Generation: 0}); err != nil {
			t.Fatalf("dup finish #%d: %v", i, err)
		}
	}
	if _, err := s.Wait(context.Background()); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	s.WaitAuthDone()
	if got := calls.Load(); got != 1 {
		t.Fatalf("authenticator called %d times, want 1", got)
	}
}

func TestOutOfPhaseRejected(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c2.Close()
	s := handshake.NewSession(c1, okAuth("p"))

	if err := s.HandleMessage(handshake.Message{Type: handshake.MessageServerHello, Generation: 0}); !errors.Is(err, handshake.ErrOutOfPhase) {
		t.Fatalf("serverhello before clienthello: %v", err)
	}
	if err := s.HandleMessage(handshake.Message{Type: handshake.MessageFinish, Generation: 0}); !errors.Is(err, handshake.ErrOutOfPhase) {
		t.Fatalf("finish before clienthello: %v", err)
	}
	if err := s.HandleMessage(handshake.Message{Type: handshake.MessageClientHello, Generation: 0}); err != nil {
		t.Fatalf("clienthello: %v", err)
	}
	if err := s.HandleMessage(handshake.Message{Type: handshake.MessageFinish, Generation: 0}); !errors.Is(err, handshake.ErrOutOfPhase) {
		t.Fatalf("finish before serverhello: %v", err)
	}
	if err := s.HandleMessage(handshake.Message{Type: handshake.MessageType(9), Generation: 0}); !errors.Is(err, handshake.ErrUnknownMessage) {
		t.Fatalf("unknown message: %v", err)
	}
	s.Cancel()
}

func TestStaleGenerationRejected(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c2.Close()
	s := handshake.NewSession(c1, okAuth("p"))

	if err := s.HandleMessage(handshake.Message{Type: handshake.MessageClientHello, Generation: 7}); !errors.Is(err, handshake.ErrStaleGeneration) {
		t.Fatalf("foreign generation: %v", err)
	}
	s.Cancel()
}

func TestCancelUnblocksWaitAndAuth(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c2.Close()
	authStarted := make(chan struct{})
	authCancelled := make(chan struct{})
	auth := handshake.AuthenticatorFunc(func(ctx context.Context, req handshake.AuthRequest) (handshake.AuthResult, error) {
		close(authStarted)
		<-ctx.Done()
		close(authCancelled)
		return handshake.AuthResult{}, ctx.Err()
	})
	s := handshake.NewSession(c1, auth)
	driveToFinish(t, s, 0)

	select {
	case <-authStarted:
	case <-time.After(testTimeout):
		t.Fatal("auth did not start")
	}

	s.Cancel()

	if _, err := s.Wait(context.Background()); !errors.Is(err, handshake.ErrCancelled) {
		t.Fatalf("Wait after cancel: %v", err)
	}
	select {
	case <-authCancelled:
	case <-time.After(testTimeout):
		t.Fatal("auth context was not cancelled")
	}
	s.WaitAuthDone()

	// Connection must not be delivered and must be closed.
	if _, err := c1.Write([]byte("x")); err == nil {
		t.Fatal("guarded conn still writable after cancel")
	}
}

func TestLateAuthSuccessDoesNotLeakOrDeliver(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c2.Close()
	release := make(chan struct{})
	auth := handshake.AuthenticatorFunc(func(ctx context.Context, req handshake.AuthRequest) (handshake.AuthResult, error) {
		<-ctx.Done() // observe cancellation
		<-release    // then finish late, after Cancel returned
		return handshake.AuthResult{PeerID: "late"}, nil
	})
	s := handshake.NewSession(c1, auth)
	driveToFinish(t, s, 0)

	s.Cancel()
	if _, err := s.Wait(context.Background()); !errors.Is(err, handshake.ErrCancelled) {
		t.Fatalf("Wait: %v", err)
	}

	// Let the late success race against the barrier; it must be dropped.
	close(release)
	s.WaitAuthDone()

	if _, err := s.Wait(context.Background()); !errors.Is(err, handshake.ErrCancelled) {
		t.Fatalf("late auth changed outcome: %v", err)
	}
	if _, err := c1.Write([]byte("x")); err == nil {
		t.Fatal("conn leaked: still writable after late auth")
	}
}

func TestAuthFailureClosesConn(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c2.Close()
	authErr := errors.New("bad credentials")
	auth := handshake.AuthenticatorFunc(func(ctx context.Context, req handshake.AuthRequest) (handshake.AuthResult, error) {
		return handshake.AuthResult{}, authErr
	})
	s := handshake.NewSession(c1, auth)
	driveToFinish(t, s, 0)

	if _, err := s.Wait(context.Background()); !errors.Is(err, authErr) {
		t.Fatalf("Wait: %v", err)
	}
	if _, err := c1.Write([]byte("x")); err == nil {
		t.Fatal("conn still writable after auth failure")
	}
	s.WaitAuthDone()
}

func TestResetStartsNewGenerationAndDropsLateAuth(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c2.Close()
	gen0AuthStarted := make(chan struct{})
	gen0Release := make(chan struct{})
	auth := handshake.AuthenticatorFunc(func(ctx context.Context, req handshake.AuthRequest) (handshake.AuthResult, error) {
		if req.Generation == 0 {
			close(gen0AuthStarted)
			<-ctx.Done()
			<-gen0Release
			return handshake.AuthResult{PeerID: "stale"}, nil
		}
		return handshake.AuthResult{PeerID: "fresh"}, nil
	})
	s := handshake.NewSession(c1, auth)
	driveToFinish(t, s, 0)
	select {
	case <-gen0AuthStarted:
	case <-time.After(testTimeout):
		t.Fatal("gen-0 auth did not start")
	}

	s.Reset(1)
	if got := s.Generation(); got != 1 {
		t.Fatalf("generation after reset: %d", got)
	}
	// Old-generation messages are now rejected.
	if err := s.HandleMessage(handshake.Message{Type: handshake.MessageClientHello, Generation: 0}); !errors.Is(err, handshake.ErrStaleGeneration) {
		t.Fatalf("gen-0 message after reset: %v", err)
	}

	driveToFinish(t, s, 1)
	conn, err := s.Wait(context.Background())
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if conn.Auth.PeerID != "fresh" || conn.Generation != 1 {
		t.Fatalf("unexpected delivery: %+v", conn)
	}

	// The stale gen-0 success arrives late and must be dropped by the barrier.
	close(gen0Release)
	s.WaitAuthDone()
	again, err := s.Wait(context.Background())
	if err != nil || again.Auth.PeerID != "fresh" {
		t.Fatalf("late gen-0 auth leaked into session: %v %+v", err, again)
	}
}

func TestNoGoroutineLeakAfterCancel(t *testing.T) {
	before := runtime.NumGoroutine()
	for i := 0; i < 20; i++ {
		c1, c2 := net.Pipe()
		auth := handshake.AuthenticatorFunc(func(ctx context.Context, req handshake.AuthRequest) (handshake.AuthResult, error) {
			<-ctx.Done()
			return handshake.AuthResult{}, ctx.Err()
		})
		s := handshake.NewSession(c1, auth)
		driveToFinish(t, s, 0)
		s.Cancel()
		s.WaitAuthDone()
		c2.Close()
	}
	deadline := time.Now().Add(testTimeout)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := runtime.NumGoroutine(); got > before {
		t.Fatalf("goroutine leak: before=%d after=%d", before, got)
	}
}

func TestWaitRespectsContext(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c2.Close()
	defer c1.Close()
	auth := handshake.AuthenticatorFunc(func(ctx context.Context, req handshake.AuthRequest) (handshake.AuthResult, error) {
		<-ctx.Done()
		return handshake.AuthResult{}, ctx.Err()
	})
	s := handshake.NewSession(c1, auth)
	driveToFinish(t, s, 0)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := s.Wait(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Wait with timeout ctx: %v", err)
	}
	s.Cancel()
	s.WaitAuthDone()
}
