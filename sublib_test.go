package sublib

import (
	"context"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---- controlled transport ----

// connPlan scripts one connection generation.
type connPlan struct {
	script  []uint64        // explicit seqs to deliver; nil = sequential from dialed fromSeq
	deliver int             // sequential deliveries before the conn drops (script == nil)
	failAck map[uint64]bool // seqs whose first Ack fails: drop between delivery and ack
	block   bool            // after deliveries, block in Recv until ctx cancelled
}

type fakeServer struct {
	mu     sync.Mutex
	log    []Message
	dials  []uint64
	conns  []*fakeConn
	planFn func(connIndex int, fromSeq uint64) connPlan
}

func newServer(n int, planFn func(connIndex int, fromSeq uint64) connPlan) *fakeServer {
	log := make([]Message, n)
	for i := range log {
		log[i] = Message{
			Seq:      uint64(i + 1),
			ResultID: fmt.Sprintf("result-%d", i+1),
			Payload:  []byte(fmt.Sprintf("payload-%d", i+1)),
		}
	}
	return &fakeServer{log: log, planFn: planFn}
}

func (s *fakeServer) Dial(ctx context.Context, fromSeq uint64) (Conn, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	plan := connPlan{deliver: len(s.log) - int(fromSeq) + 1}
	if s.planFn != nil {
		plan = s.planFn(len(s.conns), fromSeq)
	}
	c := &fakeConn{srv: s, fromSeq: fromSeq, plan: plan, recvStarted: make(chan struct{})}
	s.dials = append(s.dials, fromSeq)
	s.conns = append(s.conns, c)
	return c, nil
}

func (s *fakeServer) dialFroms() []uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]uint64, len(s.dials))
	copy(out, s.dials)
	return out
}

func (s *fakeServer) conn(i int) *fakeConn {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conns[i]
}

func (s *fakeServer) numConns() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.conns)
}

type fakeConn struct {
	srv         *fakeServer
	fromSeq     uint64
	plan        connPlan
	recvStarted chan struct{}
	startOnce   sync.Once

	mu        sync.Mutex
	delivered int
	acked     []uint64
	closed    bool
	recvErr   error
}

func (c *fakeConn) Recv(ctx context.Context) (Message, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return Message{}, io.EOF
	}
	var seq uint64
	if c.plan.script != nil {
		if c.delivered < len(c.plan.script) {
			seq = c.plan.script[c.delivered]
		}
	} else if c.delivered < c.plan.deliver {
		seq = c.fromSeq + uint64(c.delivered)
	}
	if seq == 0 {
		block := c.plan.block
		c.mu.Unlock()
		if block {
			c.startOnce.Do(func() { close(c.recvStarted) })
			<-ctx.Done()
			c.mu.Lock()
			c.recvErr = ctx.Err()
			c.mu.Unlock()
			return Message{}, ctx.Err()
		}
		return Message{}, io.EOF // connection dropped
	}
	c.delivered++
	msg := c.srv.log[seq-1]
	c.mu.Unlock()
	return msg, nil
}

func (c *fakeConn) Ack(ctx context.Context, seq uint64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return io.EOF
	}
	if c.plan.failAck[seq] {
		delete(c.plan.failAck, seq)
		return errors.New("fake: connection dropped before ack")
	}
	c.acked = append(c.acked, seq)
	return nil
}

func (c *fakeConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	return nil
}

func (c *fakeConn) ackedSeqs() []uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]uint64, len(c.acked))
	copy(out, c.acked)
	return out
}

func (c *fakeConn) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (c *fakeConn) recvError() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.recvErr
}

// ---- test helpers ----

type callLog struct {
	mu    sync.Mutex
	calls []Message
}

func (l *callLog) add(m Message) {
	l.mu.Lock()
	l.calls = append(l.calls, m)
	l.mu.Unlock()
}

func (l *callLog) seqs() []uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]uint64, len(l.calls))
	for i, m := range l.calls {
		out[i] = m.Seq
	}
	return out
}

func (l *callLog) resultIDsFor(seq uint64) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []string
	for _, m := range l.calls {
		if m.Seq == seq {
			out = append(out, m.ResultID)
		}
	}
	return out
}

func noBackoff(attempt int) time.Duration { return 0 }

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func assertLedger(t *testing.T, c *Client, want int) {
	t.Helper()
	entries := c.Ledger()
	if len(entries) != want {
		t.Fatalf("ledger has %d entries, want %d\n%s", len(entries), want, c.LedgerString())
	}
	for i, e := range entries {
		if e.Seq != uint64(i+1) {
			t.Fatalf("ledger gap at index %d: seq=%d\n%s", i, e.Seq, c.LedgerString())
		}
		if e.ResultID != fmt.Sprintf("result-%d", i+1) {
			t.Fatalf("ledger entry %d has result %q, want %q", i, e.ResultID, fmt.Sprintf("result-%d", i+1))
		}
	}
}

// ---- tests ----

// Disconnect mid-stream: the next dial must resume from last ack + 1 and
// the ledger must cover 1..N with no gaps.
func TestResumeFromLastAck(t *testing.T) {
	srv := newServer(5, func(idx int, from uint64) connPlan {
		if idx == 0 {
			return connPlan{deliver: 2} // drop after seq 2
		}
		return connPlan{deliver: 5 - int(from) + 1}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var calls callLog
	c := NewClient(srv, func(ctx context.Context, m Message) error {
		calls.add(m)
		if m.Seq == 5 {
			cancel()
		}
		return nil
	}, WithBackoff(noBackoff))

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run returned %v, want context.Canceled", err)
	}
	if got := srv.dialFroms(); !reflect.DeepEqual(got, []uint64{1, 3}) {
		t.Fatalf("dial fromSeqs = %v, want [1 3]", got)
	}
	if got := calls.seqs(); !reflect.DeepEqual(got, []uint64{1, 2, 3, 4, 5}) {
		t.Fatalf("handler seqs = %v, want [1 2 3 4 5]", got)
	}
	assertLedger(t, c, 5)
}

// The connection drops after delivery of seq 2 but before its ack lands.
// The client must not advance the ledger, must redial from seq 2, and the
// redelivered result must carry the same ResultID.
func TestDropBetweenDeliveryAndAck(t *testing.T) {
	srv := newServer(3, func(idx int, from uint64) connPlan {
		if idx == 0 {
			return connPlan{deliver: 3, failAck: map[uint64]bool{2: true}}
		}
		return connPlan{deliver: 3 - int(from) + 1}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var calls callLog
	c := NewClient(srv, func(ctx context.Context, m Message) error {
		calls.add(m)
		if m.Seq == 3 {
			cancel()
		}
		return nil
	}, WithBackoff(noBackoff))

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run returned %v, want context.Canceled", err)
	}
	if got := srv.dialFroms(); !reflect.DeepEqual(got, []uint64{1, 2}) {
		t.Fatalf("dial fromSeqs = %v, want [1 2]", got)
	}
	// seq 2 was delivered twice (once per generation), handler saw both.
	if got := calls.seqs(); !reflect.DeepEqual(got, []uint64{1, 2, 2, 3}) {
		t.Fatalf("handler seqs = %v, want [1 2 2 3]", got)
	}
	if ids := calls.resultIDsFor(2); !reflect.DeepEqual(ids, []string{"result-2", "result-2"}) {
		t.Fatalf("redelivery ResultIDs = %v, want stable result-2", ids)
	}
	// conn 0 only ever acked seq 1.
	if got := srv.conn(0).ackedSeqs(); !reflect.DeepEqual(got, []uint64{1}) {
		t.Fatalf("conn0 acks = %v, want [1]", got)
	}
	// No gap, no double entry in the ledger.
	assertLedger(t, c, 3)
}

// A handler failure must not advance the ack: the client reconnects and
// the same result is redelivered with a stable ResultID.
func TestHandlerFailureRedeliversStableID(t *testing.T) {
	srv := newServer(3, nil) // default: serve everything from fromSeq
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var calls callLog
	failed := false
	c := NewClient(srv, func(ctx context.Context, m Message) error {
		calls.add(m)
		if m.Seq == 2 && !failed {
			failed = true
			return errors.New("transient handler error")
		}
		if m.Seq == 3 {
			cancel()
		}
		return nil
	}, WithBackoff(noBackoff))

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run returned %v, want context.Canceled", err)
	}
	if got := srv.dialFroms(); !reflect.DeepEqual(got, []uint64{1, 2}) {
		t.Fatalf("dial fromSeqs = %v, want [1 2]", got)
	}
	if got := calls.seqs(); !reflect.DeepEqual(got, []uint64{1, 2, 2, 3}) {
		t.Fatalf("handler seqs = %v, want [1 2 2 3]", got)
	}
	if ids := calls.resultIDsFor(2); !reflect.DeepEqual(ids, []string{"result-2", "result-2"}) {
		t.Fatalf("redelivery ResultIDs = %v, want stable result-2", ids)
	}
	if got := srv.conn(0).ackedSeqs(); !reflect.DeepEqual(got, []uint64{1}) {
		t.Fatalf("conn0 acks = %v, want [1]", got)
	}
	assertLedger(t, c, 3)
}

// A new generation must cancel the old connection: Recv on the old conn
// unblocks with context.Canceled and the conn is closed before the new
// generation serves traffic.
func TestNewGenerationCancelsOldConnection(t *testing.T) {
	srv := newServer(3, func(idx int, from uint64) connPlan {
		if idx == 0 {
			return connPlan{deliver: 1, block: true}
		}
		return connPlan{deliver: 3 - int(from) + 1, block: true}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var calls callLog
	c := NewClient(srv, func(ctx context.Context, m Message) error {
		calls.add(m)
		if m.Seq == 3 {
			cancel()
		}
		return nil
	}, WithBackoff(noBackoff))

	done := make(chan error, 1)
	go func() { done <- c.Run(ctx) }()

	waitFor(t, "first connection", func() bool { return srv.numConns() == 1 })
	conn0 := srv.conn(0)
	select {
	case <-conn0.recvStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("conn0 never blocked in Recv")
	}
	if gen := c.Generation(); gen != 1 {
		t.Fatalf("generation = %d, want 1", gen)
	}

	c.Reconnect()

	waitFor(t, "second connection", func() bool { return srv.numConns() == 2 })
	waitFor(t, "old connection cancelled and closed", func() bool {
		return conn0.isClosed() && errors.Is(conn0.recvError(), context.Canceled)
	})

	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run returned %v, want context.Canceled", err)
	}
	if got := srv.dialFroms(); !reflect.DeepEqual(got, []uint64{1, 2}) {
		t.Fatalf("dial fromSeqs = %v, want [1 2]", got)
	}
	if gen := c.Generation(); gen != 2 {
		t.Fatalf("generation = %d, want 2", gen)
	}
	assertLedger(t, c, 3)
}

// If the server redelivers an already-acked seq, the client re-acks it
// without invoking the handler again (idempotent, stable ResultID).
func TestDuplicateDeliveryReAckedWithoutHandler(t *testing.T) {
	srv := newServer(3, func(idx int, from uint64) connPlan {
		return connPlan{script: []uint64{1, 1, 2, 3}}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var calls callLog
	c := NewClient(srv, func(ctx context.Context, m Message) error {
		calls.add(m)
		if m.Seq == 3 {
			cancel()
		}
		return nil
	}, WithBackoff(noBackoff))

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run returned %v, want context.Canceled", err)
	}
	if got := calls.seqs(); !reflect.DeepEqual(got, []uint64{1, 2, 3}) {
		t.Fatalf("handler seqs = %v, want [1 2 3] (duplicate suppressed)", got)
	}
	if got := srv.conn(0).ackedSeqs(); !reflect.DeepEqual(got, []uint64{1, 1, 2, 3}) {
		t.Fatalf("conn0 acks = %v, want [1 1 2 3] (duplicate re-acked)", got)
	}
	assertLedger(t, c, 3)
}

// The ledger rejects out-of-order records and renders the ack book.
func TestLedgerGapFreeAndPrintable(t *testing.T) {
	var l Ledger
	if err := l.Record(2, "result-2"); err == nil {
		t.Fatal("Record(2) on empty ledger: want gap error")
	}
	if err := l.Record(1, "result-1"); err != nil {
		t.Fatalf("Record(1): %v", err)
	}
	if err := l.Record(2, "result-2"); err != nil {
		t.Fatalf("Record(2): %v", err)
	}
	if !l.Acked(1) || !l.Acked(2) || l.Acked(3) {
		t.Fatal("Acked reports wrong coverage")
	}
	if l.LastAck() != 2 {
		t.Fatalf("LastAck = %d, want 2", l.LastAck())
	}
	s := l.String()
	for _, want := range []string{"ack ledger (2 entries, last=2)", "seq=1 result=result-1", "seq=2 result=result-2"} {
		if !strings.Contains(s, want) {
			t.Fatalf("ledger output missing %q:\n%s", want, s)
		}
	}
}
