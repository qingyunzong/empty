package handshake

import (
	"context"
	"errors"
	"io"
	"net"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

func newPipe(t *testing.T) (client, server net.Conn) {
	t.Helper()
	client, server = net.Pipe()
	t.Cleanup(func() {
		client.Close()
		server.Close()
	})
	return client, server
}

func drive(t *testing.T, m *Machine, gen uint64) {
	t.Helper()
	for _, typ := range []MsgType{MsgClientHello, MsgServerHello, MsgFinish} {
		if err := m.HandleMessage(Message{Type: typ, Generation: gen, Payload: []byte(typ.String())}); err != nil {
			t.Fatalf("HandleMessage(%s): %v", typ, err)
		}
	}
}

func TestHappyPathDeliversConnAfterAuth(t *testing.T) {
	_, server := newPipe(t)

	var gotInfo AuthInfo
	m := NewMachine(server, AuthenticatorFunc(func(ctx context.Context, info AuthInfo) error {
		gotInfo = info
		return nil
	}))
	defer m.Close()

	drive(t, m, 7)

	conn, err := m.WaitConn(context.Background())
	if err != nil {
		t.Fatalf("WaitConn: %v", err)
	}
	if conn != server {
		t.Fatal("WaitConn did not return the wrapped connection")
	}
	if gotInfo.Generation != 7 {
		t.Fatalf("auth generation = %d, want 7", gotInfo.Generation)
	}
	if string(gotInfo.ClientHelloPayload) != "clienthello" ||
		string(gotInfo.ServerHelloPayload) != "serverhello" ||
		string(gotInfo.FinishPayload) != "finish" {
		t.Fatalf("auth info payloads wrong: %+v", gotInfo)
	}
	if m.Phase() != PhaseFinish {
		t.Fatalf("phase = %v, want finish", m.Phase())
	}
}

func TestDuplicateSameGenerationIdempotent(t *testing.T) {
	_, server := newPipe(t)

	var authCalls atomic.Int32
	m := NewMachine(server, AuthenticatorFunc(func(ctx context.Context, info AuthInfo) error {
		authCalls.Add(1)
		return nil
	}))
	defer m.Close()

	const gen = 42
	// Every message sent twice; duplicates of already-consumed messages
	// interleaved as well.
	seq := []MsgType{
		MsgClientHello, MsgClientHello,
		MsgServerHello, MsgClientHello, MsgServerHello,
		MsgFinish, MsgClientHello, MsgServerHello, MsgFinish, MsgFinish,
	}
	for _, typ := range seq {
		if err := m.HandleMessage(Message{Type: typ, Generation: gen}); err != nil {
			t.Fatalf("duplicate %s rejected: %v", typ, err)
		}
	}

	if _, err := m.WaitConn(context.Background()); err != nil {
		t.Fatalf("WaitConn: %v", err)
	}
	if n := authCalls.Load(); n != 1 {
		t.Fatalf("authenticator called %d times, want exactly 1", n)
	}
}

func TestOutOfPhaseRejected(t *testing.T) {
	_, server := newPipe(t)
	m := NewMachine(server, AuthenticatorFunc(func(context.Context, AuthInfo) error { return nil }))
	defer m.Close()

	const gen = 1
	if err := m.HandleMessage(Message{Type: MsgServerHello, Generation: gen}); !errors.Is(err, ErrOutOfPhase) {
		t.Fatalf("serverhello at init: %v, want ErrOutOfPhase", err)
	}
	if err := m.HandleMessage(Message{Type: MsgFinish, Generation: gen}); !errors.Is(err, ErrOutOfPhase) {
		t.Fatalf("finish at init: %v, want ErrOutOfPhase", err)
	}
	if err := m.HandleMessage(Message{Type: MsgClientHello, Generation: gen}); err != nil {
		t.Fatalf("clienthello: %v", err)
	}
	if err := m.HandleMessage(Message{Type: MsgFinish, Generation: gen}); !errors.Is(err, ErrOutOfPhase) {
		t.Fatalf("finish after clienthello: %v, want ErrOutOfPhase", err)
	}
	if m.Phase() != PhaseClientHello {
		t.Fatalf("phase = %v, want clienthello (rejections must not advance state)", m.Phase())
	}
}

func TestGenerationMismatchRejected(t *testing.T) {
	_, server := newPipe(t)
	m := NewMachine(server, AuthenticatorFunc(func(context.Context, AuthInfo) error { return nil }))
	defer m.Close()

	if err := m.HandleMessage(Message{Type: MsgClientHello, Generation: 1}); err != nil {
		t.Fatalf("clienthello: %v", err)
	}
	for _, typ := range []MsgType{MsgClientHello, MsgServerHello, MsgFinish} {
		if err := m.HandleMessage(Message{Type: typ, Generation: 2}); !errors.Is(err, ErrGenerationMismatch) {
			t.Fatalf("%s with foreign generation: %v, want ErrGenerationMismatch", typ, err)
		}
	}
}

func TestAuthFailureNeverDeliversConn(t *testing.T) {
	client, server := newPipe(t)

	authErr := errors.New("bad credentials")
	m := NewMachine(server, AuthenticatorFunc(func(context.Context, AuthInfo) error { return authErr }))
	defer m.Close()

	drive(t, m, 3)

	if _, err := m.WaitConn(context.Background()); !errors.Is(err, authErr) {
		t.Fatalf("WaitConn: %v, want wrapped auth error", err)
	}
	// The connection must be closed, never delivered: the peer observes EOF.
	client.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := client.Read(make([]byte, 1)); err != io.EOF && !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("peer read after auth failure: %v, want EOF (conn closed)", err)
	}
}

func TestCloseCancelsAuthAndLateResultDoesNotLeak(t *testing.T) {
	_, server := newPipe(t)

	before := runtime.NumGoroutine()
	authStarted := make(chan struct{})
	releaseAuth := make(chan struct{})
	m := NewMachine(server, AuthenticatorFunc(func(ctx context.Context, info AuthInfo) error {
		close(authStarted)
		select {
		case <-ctx.Done():
			// Observe cancellation, then take our time: the result is "late".
			time.Sleep(50 * time.Millisecond)
			return nil
		case <-releaseAuth:
			return nil
		}
	}))

	drive(t, m, 9)

	waitErr := make(chan error, 1)
	go func() {
		_, err := m.WaitConn(context.Background())
		waitErr <- err
	}()

	<-authStarted
	if err := m.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	select {
	case err := <-waitErr:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("WaitConn after Close: %v, want ErrClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("WaitConn did not return after Close")
	}

	// Late auth result must be discarded: connection closed, never delivered.
	if _, err := server.Write([]byte("x")); err == nil {
		t.Fatal("write on undelivered conn succeeded after Close; want closed conn")
	}
	if _, err := m.WaitConn(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("second WaitConn: %v, want ErrClosed", err)
	}

	// No goroutine leak: the auth goroutine must exit after its late result.
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := runtime.NumGoroutine(); n > before {
		t.Fatalf("goroutines leaked: before=%d after=%d", before, n)
	}
}

func TestCallerCancelDoesNotKillMachine(t *testing.T) {
	_, server := newPipe(t)

	releaseAuth := make(chan struct{})
	m := NewMachine(server, AuthenticatorFunc(func(ctx context.Context, info AuthInfo) error {
		select {
		case <-releaseAuth:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}))
	defer m.Close()

	drive(t, m, 5)

	ctx, cancel := context.WithCancel(context.Background())
	waitErr := make(chan error, 1)
	go func() {
		_, err := m.WaitConn(ctx)
		waitErr <- err
	}()
	cancel()
	select {
	case err := <-waitErr:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("WaitConn with cancelled ctx: %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("WaitConn did not honor caller cancellation")
	}

	// The late (successful) auth result is buffered, not leaked: a fresh
	// caller can still take delivery of the connection.
	close(releaseAuth)
	conn, err := m.WaitConn(context.Background())
	if err != nil {
		t.Fatalf("WaitConn after late auth success: %v", err)
	}
	if conn != server {
		t.Fatal("late auth success failed to deliver the wrapped connection")
	}
}

func TestDoubleDeliveryRejected(t *testing.T) {
	_, server := newPipe(t)
	m := NewMachine(server, AuthenticatorFunc(func(context.Context, AuthInfo) error { return nil }))
	defer m.Close()

	drive(t, m, 1)

	if _, err := m.WaitConn(context.Background()); err != nil {
		t.Fatalf("first WaitConn: %v", err)
	}
	if _, err := m.WaitConn(context.Background()); !errors.Is(err, ErrAlreadyDelivered) {
		t.Fatalf("second WaitConn: %v, want ErrAlreadyDelivered", err)
	}
}
