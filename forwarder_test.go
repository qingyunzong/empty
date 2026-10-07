package forward

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

// scriptedSource is a controlled read end. Each step is either a chunk
// (possibly empty) or an injected error. When the script is exhausted it
// returns io.EOF, or blocks on gate if gate is non-nil.
type scriptedSource struct {
	mu     sync.Mutex
	steps  []readStep
	pos    int
	gate   chan struct{}
	closed int
	reads  int
}

type readStep struct {
	data []byte
	err  error
}

func chunks(chunks ...string) []readStep {
	steps := make([]readStep, len(chunks))
	for i, c := range chunks {
		steps[i].data = []byte(c)
	}
	return steps
}

func (s *scriptedSource) ReadChunk() ([]byte, error) {
	s.mu.Lock()
	if s.pos >= len(s.steps) {
		gate := s.gate
		s.mu.Unlock()
		if gate != nil {
			<-gate
		}
		return nil, io.EOF
	}
	s.reads++
	st := s.steps[s.pos]
	s.pos++
	s.mu.Unlock()
	return st.data, st.err
}

func (s *scriptedSource) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed++
	if s.gate != nil {
		close(s.gate)
		s.gate = nil
	}
	return nil
}

func (s *scriptedSource) closeCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// recordingSink is a controlled write end. It can fail on a chosen write
// number, hold leases, and block inside Write to simulate in-flight work.
type recordingSink struct {
	mu         sync.Mutex
	writes     [][]byte
	written    int64
	closeErrs  []error
	failOnCall int // 1-based Write call that returns errWrite; 0 = never
	holdLeases bool
	held       []*Chunk
	entered    chan struct{}
	unblock    chan struct{}
}

var errWrite = errors.New("write boom")

func (s *recordingSink) Write(c *Chunk) error {
	s.mu.Lock()
	call := len(s.writes) + 1
	if s.entered != nil {
		select {
		case s.entered <- struct{}{}:
		default:
		}
	}
	unblock := s.unblock
	s.mu.Unlock()
	if unblock != nil {
		<-unblock
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failOnCall == call {
		c.Release()
		return errWrite
	}
	buf := append([]byte(nil), c.Data...)
	s.writes = append(s.writes, buf)
	s.written += int64(len(buf))
	if s.holdLeases {
		s.held = append(s.held, c)
	} else {
		c.Release()
	}
	return nil
}

func (s *recordingSink) Close(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeErrs = append(s.closeErrs, err)
}

func (s *recordingSink) closeCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.closeErrs)
}

func (s *recordingSink) lastCloseErr() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.closeErrs) == 0 {
		return nil
	}
	return s.closeErrs[len(s.closeErrs)-1]
}

func (s *recordingSink) payload() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []byte
	for _, w := range s.writes {
		out = append(out, w...)
	}
	return out
}

func (s *recordingSink) writeCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.writes)
}

// barrier verifies the two cross-cutting invariants: the byte budget was
// respected and every sink reached exactly one terminal state.
func verifyBarrier(t *testing.T, res Result, maxBytes int64, sinks ...*recordingSink) {
	t.Helper()
	if maxBytes >= 0 && res.BytesPublished > maxBytes {
		t.Errorf("budget exceeded: published %d > limit %d", res.BytesPublished, maxBytes)
	}
	if res.Outcome == Delivered && res.Err != nil {
		t.Errorf("delivered with non-nil error %v", res.Err)
	}
	if res.Outcome != Delivered && res.Err == nil {
		t.Errorf("outcome %v with nil error", res.Outcome)
	}
	for i, s := range sinks {
		if n := s.closeCount(); n != 1 {
			t.Errorf("sink %d: closed %d times, want exactly one terminal state", i, n)
		}
	}
}

func TestDelivered(t *testing.T) {
	src := &scriptedSource{steps: chunks("hello", "", " ", "world")}
	a, b := &recordingSink{}, &recordingSink{}
	f := &Forwarder{MaxBytes: 100}
	res := f.Forward(context.Background(), src, a, b)

	if res.Outcome != Delivered || res.Err != nil {
		t.Fatalf("outcome = %v err = %v, want delivered", res.Outcome, res.Err)
	}
	if res.BytesRead != 11 || res.BytesPublished != 11 {
		t.Fatalf("read %d published %d, want 11/11", res.BytesRead, res.BytesPublished)
	}
	for i, s := range []*recordingSink{a, b} {
		if got := string(s.payload()); got != "hello world" {
			t.Fatalf("sink %d payload = %q", i, got)
		}
		if n := len(s.writes); n != 4 {
			t.Fatalf("sink %d writes = %d, want 4 (empty chunk included)", i, n)
		}
	}
	if src.closed != 1 {
		t.Fatalf("source closed %d times, want 1", src.closed)
	}
	verifyBarrier(t, res, 100, a, b)
}

func TestEmptyChunksOnly(t *testing.T) {
	src := &scriptedSource{steps: chunks("", "", "")}
	sink := &recordingSink{}
	res := (&Forwarder{MaxBytes: 0}).Forward(context.Background(), src, sink)
	if res.Outcome != Delivered {
		t.Fatalf("outcome = %v, want delivered (empty chunks are not EOF)", res.Outcome)
	}
	if res.BytesRead != 0 || res.BytesPublished != 0 {
		t.Fatalf("read %d published %d, want 0/0", res.BytesRead, res.BytesPublished)
	}
	if n := len(sink.writes); n != 3 {
		t.Fatalf("writes = %d, want 3 empty writes", n)
	}
	verifyBarrier(t, res, 0, sink)
}

func TestLimitExceededStopsPublishingAndClosesUpstream(t *testing.T) {
	src := &scriptedSource{steps: chunks("aaaaa", "bbbbb", "ccccc")}
	sink := &recordingSink{}
	f := &Forwarder{MaxBytes: 7}
	res := f.Forward(context.Background(), src, sink)

	if res.Outcome != LimitExceeded {
		t.Fatalf("outcome = %v, want limit-exceeded", res.Outcome)
	}
	if !errors.Is(res.Err, ErrLimitExceeded) {
		t.Fatalf("err = %v, want ErrLimitExceeded", res.Err)
	}
	var rf *ReadFailure
	if errors.As(res.Err, &rf) {
		t.Fatalf("limit error misclassified as read failure: %v", rf)
	}
	if res.BytesRead != 10 {
		t.Fatalf("BytesRead = %d, want 10 (tripping block counted)", res.BytesRead)
	}
	if res.BytesPublished != 5 {
		t.Fatalf("BytesPublished = %d, want 5 (tripping block not published)", res.BytesPublished)
	}
	if src.reads != 2 {
		t.Fatalf("reads = %d, want 2: publishing must stop immediately", src.reads)
	}
	if src.closed != 1 {
		t.Fatalf("upstream closed %d times, want 1", src.closed)
	}
	// The prefix went out, but the sink must see failure, not success.
	if got := string(sink.payload()); got != "aaaaa" {
		t.Fatalf("sink payload = %q, want prefix %q", got, "aaaaa")
	}
	if !errors.Is(sink.lastCloseErr(), ErrLimitExceeded) {
		t.Fatalf("sink terminal = %v, want ErrLimitExceeded (prefix is not success)", sink.lastCloseErr())
	}
	verifyBarrier(t, res, 7, sink)
}

func TestReadErrorPositionsByteAccounting(t *testing.T) {
	sizes := []string{"aaa", "bbbb", "cc"}
	boom := errors.New("read boom")
	for failAt := 0; failAt <= len(sizes); failAt++ {
		steps := chunks(sizes...)
		if failAt < len(steps) {
			steps[failAt].err = boom
			steps[failAt].data = nil
		} else {
			steps = append(steps, readStep{err: boom})
		}
		src := &scriptedSource{steps: steps}
		sink := &recordingSink{}
		res := (&Forwarder{MaxBytes: 100}).Forward(context.Background(), src, sink)

		if res.Outcome != ReadFailed {
			t.Fatalf("failAt %d: outcome = %v, want read-failed", failAt, res.Outcome)
		}
		var rf *ReadFailure
		if !errors.As(res.Err, &rf) || !errors.Is(res.Err, boom) {
			t.Fatalf("failAt %d: err = %v, want ReadFailure wrapping boom", failAt, res.Err)
		}
		if errors.Is(res.Err, ErrLimitExceeded) {
			t.Fatalf("failAt %d: read failure misclassified as limit", failAt)
		}
		var wantRead int64
		for _, s := range sizes[:failAt] {
			wantRead += int64(len(s))
		}
		if res.BytesRead != wantRead || rf.Off != wantRead {
			t.Fatalf("failAt %d: read %d off %d, want %d", failAt, res.BytesRead, rf.Off, wantRead)
		}
		if res.BytesPublished != wantRead {
			t.Fatalf("failAt %d: published %d, want %d", failAt, res.BytesPublished, wantRead)
		}
		if sink.written != wantRead {
			t.Fatalf("failAt %d: sink wrote %d, want %d", failAt, sink.written, wantRead)
		}
		if !errors.Is(sink.lastCloseErr(), boom) {
			t.Fatalf("failAt %d: sink terminal = %v, want boom", failAt, sink.lastCloseErr())
		}
		verifyBarrier(t, res, 100, sink)
	}
}

func TestWriteErrorPositionsByteAccounting(t *testing.T) {
	sizes := []string{"aa", "bbb", "c"}
	for failAt := 0; failAt < len(sizes); failAt++ {
		src := &scriptedSource{steps: chunks(sizes...), gate: make(chan struct{})}
		sink := &recordingSink{failOnCall: failAt + 1}
		res := (&Forwarder{MaxBytes: 100}).Forward(context.Background(), src, sink)

		if res.Outcome != WriteFailed {
			t.Fatalf("failAt %d: outcome = %v, want write-failed", failAt, res.Outcome)
		}
		var sf *SinkFailure
		if !errors.As(res.Err, &sf) || !errors.Is(res.Err, errWrite) {
			t.Fatalf("failAt %d: err = %v, want SinkFailure wrapping errWrite", failAt, res.Err)
		}
		if sf.Sink != 0 {
			t.Fatalf("failAt %d: sink index = %d, want 0", failAt, sf.Sink)
		}
		var want int64
		for _, s := range sizes[:failAt+1] {
			want += int64(len(s))
		}
		if res.BytesPublished != want || sf.Off != want {
			t.Fatalf("failAt %d: published %d off %d, want %d", failAt, res.BytesPublished, sf.Off, want)
		}
		if sink.written != want-int64(len(sizes[failAt])) {
			t.Fatalf("failAt %d: sink wrote %d", failAt, sink.written)
		}
		if src.closed != 1 {
			t.Fatalf("failAt %d: upstream closed %d times, want 1", failAt, src.closed)
		}
		verifyBarrier(t, res, 100, sink)
	}
}

func TestInFlightWritesDrainedBeforeTerminateOnLimit(t *testing.T) {
	src := &scriptedSource{steps: chunks("aaaa", "bbbb")}
	sink := &recordingSink{
		entered: make(chan struct{}, 1),
		unblock: make(chan struct{}),
	}
	done := make(chan Result, 1)
	go func() {
		done <- (&Forwarder{MaxBytes: 5}).Forward(context.Background(), src, sink)
	}()

	<-sink.entered // first write is in flight and blocked
	close(sink.unblock)
	res := <-done

	if res.Outcome != LimitExceeded {
		t.Fatalf("outcome = %v, want limit-exceeded", res.Outcome)
	}
	if got := string(sink.payload()); got != "aaaa" {
		t.Fatalf("payload = %q, want the in-flight write to have completed", got)
	}
	if sink.closeCount() != 1 {
		t.Fatalf("sink closed %d times, want 1 after draining", sink.closeCount())
	}
	verifyBarrier(t, res, 5, sink)
}

func TestCancelUnblocksForward(t *testing.T) {
	src := &scriptedSource{steps: chunks("xy"), gate: make(chan struct{})}
	sink := &recordingSink{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan Result, 1)
	go func() {
		done <- (&Forwarder{MaxBytes: 100}).Forward(ctx, src, sink)
	}()
	// Let the first chunk through, then cancel while the read is blocked.
	deadline := time.Now().Add(2 * time.Second)
	for sink.writeCount() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("first chunk never arrived")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	res := <-done
	if res.Outcome != Canceled || !errors.Is(res.Err, context.Canceled) {
		t.Fatalf("outcome = %v err = %v, want canceled", res.Outcome, res.Err)
	}
	if src.closed != 1 {
		t.Fatalf("upstream closed %d times, want 1", src.closed)
	}
	verifyBarrier(t, res, 100, sink)
}

func TestRaceMainResponseVsCancel(t *testing.T) {
	for i := 0; i < 300; i++ {
		src := &scriptedSource{steps: chunks("ab", "cd")}
		sink := &recordingSink{}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan Result, 1)
		go func() {
			done <- (&Forwarder{MaxBytes: 100}).Forward(ctx, src, sink)
		}()
		if i%2 == 0 {
			cancel() // cancel may land before, during, or after delivery
		} else {
			go cancel()
		}
		res := <-done
		cancel()

		switch res.Outcome {
		case Delivered:
			if got := string(sink.payload()); got != "abcd" {
				t.Fatalf("iter %d: delivered but payload = %q", i, got)
			}
			if sink.lastCloseErr() != nil {
				t.Fatalf("iter %d: delivered but sink terminal = %v", i, sink.lastCloseErr())
			}
		case Canceled:
			if !errors.Is(sink.lastCloseErr(), context.Canceled) {
				t.Fatalf("iter %d: canceled but sink terminal = %v", i, sink.lastCloseErr())
			}
			// A delivered prefix must not flip the outcome to success.
			if res.BytesPublished > 4 {
				t.Fatalf("iter %d: published %d > body", i, res.BytesPublished)
			}
		default:
			t.Fatalf("iter %d: unexpected outcome %v", i, res.Outcome)
		}
		if n := sink.closeCount(); n != 1 {
			t.Fatalf("iter %d: %d terminal states, want exactly one", i, n)
		}
		verifyBarrier(t, res, 100, sink)
	}
}

func TestSharedLeaseAcrossDestinationsAndPoolReuse(t *testing.T) {
	pool := NewPool()
	src := &scriptedSource{steps: chunks("xy")}
	holder := &recordingSink{holdLeases: true}
	plain := &recordingSink{}
	res := (&Forwarder{MaxBytes: 10, Pool: pool}).Forward(context.Background(), src, holder, plain)
	if res.Outcome != Delivered {
		t.Fatalf("outcome = %v", res.Outcome)
	}
	// The holder still pins the shared block: the pool must not reuse it.
	if got := pool.InUse(); got != 1 {
		t.Fatalf("InUse = %d, want 1 while a destination holds its lease", got)
	}
	c := pool.Get(2)
	heldID := holder.held[0].ID()
	if c.ID() == heldID {
		t.Fatalf("block %d recycled while destination lease outstanding", heldID)
	}
	c.Release()
	// Releasing the destination lease frees the original block.
	holder.held[0].Release()
	if got := pool.InUse(); got != 0 {
		t.Fatalf("InUse = %d, want 0 after final release", got)
	}
	verifyBarrier(t, res, 10, holder, plain)
}
