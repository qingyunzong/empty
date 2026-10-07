package forward

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"
)

// --- controlled read ends ------------------------------------------------

type step struct {
	data  []byte        // chunk payload; nil with nil err yields an empty chunk
	err   error         // injected read error at this position
	block chan struct{} // if set, ReadChunk waits for it to close first
}

type scriptedSource struct {
	steps  []step
	pos    int
	closes atomic.Int32
}

func (s *scriptedSource) ReadChunk(buf []byte) (int, error) {
	if s.pos >= len(s.steps) {
		return 0, io.EOF
	}
	st := s.steps[s.pos]
	s.pos++
	if st.block != nil {
		<-st.block
	}
	if st.err != nil {
		return 0, st.err
	}
	return copy(buf, st.data), nil
}

func (s *scriptedSource) Close() error {
	s.closes.Add(1)
	return nil
}

// blockingSource blocks in ReadChunk until Close unblocks it.
type blockingSource struct {
	closed chan struct{}
	once   sync.Once
	closes atomic.Int32
}

func newBlockingSource() *blockingSource { return &blockingSource{closed: make(chan struct{})} }

func (b *blockingSource) ReadChunk([]byte) (int, error) {
	<-b.closed
	return 0, errors.New("read on closed source")
}

func (b *blockingSource) Close() error {
	b.once.Do(func() { close(b.closed) })
	b.closes.Add(1)
	return nil
}

// --- controlled write ends -----------------------------------------------

// recorder records every write attempt and can fail at a chosen position.
type recorder struct {
	name    string
	failAt  int
	failErr error

	mu      sync.Mutex
	chunks  [][]byte
	closed  bool
	termErr error
}

func newRecorder(name string) *recorder { return &recorder{name: name, failAt: -1} }

func (r *recorder) Name() string { return r.name }

func (r *recorder) WriteChunk(_ context.Context, data []byte) error {
	r.mu.Lock()
	idx := len(r.chunks)
	r.chunks = append(r.chunks, append([]byte(nil), data...))
	r.mu.Unlock()
	if idx == r.failAt {
		return r.failErr
	}
	return nil
}

func (r *recorder) Close(err error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	r.termErr = err
	return nil
}

func (r *recorder) written() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	var n int64
	for i, c := range r.chunks {
		if i == r.failAt {
			break // failed write does not count as delivered bytes
		}
		n += int64(len(c))
	}
	return n
}

// gateSink blocks every write until the gate opens, and signals entered
// when the first write is in flight.
type gateSink struct {
	gate    chan struct{}
	entered chan struct{}
	once    sync.Once

	mu      sync.Mutex
	bytes   int64
	writes  int
	closed  bool
	termErr error
}

func newGateSink() *gateSink {
	return &gateSink{gate: make(chan struct{}), entered: make(chan struct{})}
}

func (g *gateSink) WriteChunk(_ context.Context, data []byte) error {
	g.once.Do(func() { close(g.entered) })
	<-g.gate
	g.mu.Lock()
	g.bytes += int64(len(data))
	g.writes++
	g.mu.Unlock()
	return nil
}

func (g *gateSink) Close(err error) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
	g.termErr = err
	return nil
}

// ctxSink blocks in WriteChunk until the context is done.
type ctxSink struct {
	entered chan struct{}
	once    sync.Once
}

func newCtxSink() *ctxSink { return &ctxSink{entered: make(chan struct{})} }

func (c *ctxSink) WriteChunk(ctx context.Context, _ []byte) error {
	c.once.Do(func() { close(c.entered) })
	<-ctx.Done()
	return ctx.Err()
}

func (c *ctxSink) Close(error) error { return nil }

// --- delivery ------------------------------------------------------------

func TestDeliveredWithEmptyChunks(t *testing.T) {
	src := &scriptedSource{steps: []step{
		{data: []byte("aa")},
		{data: nil}, // empty chunk
		{data: []byte("bb")},
		{data: nil}, // empty chunk
		{data: []byte("ccc")},
	}}
	d1, d2 := newRecorder("d1"), newRecorder("d2")

	res := New(Config{ChunkSize: 8}).Forward(context.Background(), src, d1, d2)

	if res.State != StateDelivered || res.Err != nil {
		t.Fatalf("state=%v err=%v", res.State, res.Err)
	}
	if res.Stats.BytesRead != 7 || res.Stats.ChunksRead != 5 {
		t.Fatalf("upstream account: %+v", res.Stats)
	}
	if src.closes.Load() != 1 {
		t.Fatalf("upstream closed %d times, want 1", src.closes.Load())
	}
	for i, d := range []*recorder{d1, d2} {
		ds := res.Dests[i]
		if ds.BytesWritten != 7 || ds.ChunksWritten != 5 || ds.Err != nil {
			t.Fatalf("dest %s account: %+v", ds.Name, ds)
		}
		if len(d.chunks) != 5 || len(d.chunks[1]) != 0 || len(d.chunks[3]) != 0 {
			t.Fatalf("dest %s chunks not preserved (incl. empty): %q", ds.Name, d.chunks)
		}
		if !d.closed || d.termErr != nil {
			t.Fatalf("dest %s closed=%v termErr=%v", ds.Name, d.closed, d.termErr)
		}
	}
}

// --- limit vs read error ---------------------------------------------------

func TestLimitExceededStopsAndWaitsForInflight(t *testing.T) {
	src := &scriptedSource{steps: []step{
		{data: []byte("aaaa")},
		{data: []byte("bbbb")},
		{data: []byte("cccc")}, // pushes total to 12 > 10: never published
	}}
	sink := newGateSink()
	f := New(Config{ChunkSize: 4, MaxBytes: 10})

	done := make(chan Result, 1)
	go func() { done <- f.Forward(context.Background(), src, sink) }()

	<-sink.entered // a write is in flight when the limit trips
	select {
	case res := <-done:
		t.Fatalf("terminated before in-flight write closed: %v", res.State)
	case <-time.After(50 * time.Millisecond):
	}
	close(sink.gate)
	res := <-done

	if res.State != StateLimitExceeded || !errors.Is(res.Err, ErrLimitExceeded) {
		t.Fatalf("state=%v err=%v", res.State, res.Err)
	}
	var re *ReadError
	if errors.As(res.Err, &re) {
		t.Fatal("limit error must not be reported as a read error")
	}
	if res.Stats.BytesRead != 12 || res.Stats.ChunksRead != 2 {
		t.Fatalf("upstream account: %+v", res.Stats)
	}
	if res.Dests[0].BytesWritten != 8 || res.Dests[0].ChunksWritten != 2 {
		t.Fatalf("dest account: %+v", res.Dests[0])
	}
	if !sink.closed || !errors.Is(sink.termErr, ErrLimitExceeded) {
		t.Fatalf("sink closed=%v termErr=%v", sink.closed, sink.termErr)
	}
	if src.closes.Load() != 1 {
		t.Fatalf("upstream closed %d times, want 1", src.closes.Load())
	}
}

func TestReadErrorPositions(t *testing.T) {
	boom := errors.New("boom")
	for at := 0; at <= 2; at++ {
		t.Run(fmt.Sprintf("at=%d", at), func(t *testing.T) {
			steps := []step{{data: []byte("aa")}, {data: []byte("bb")}, {data: []byte("cc")}}
			steps[at].data, steps[at].err = nil, boom
			src := &scriptedSource{steps: steps}
			d := newRecorder("d")

			res := New(Config{ChunkSize: 8}).Forward(context.Background(), src, d)

			if res.State != StateReadFailed {
				t.Fatalf("state=%v", res.State)
			}
			var re *ReadError
			if !errors.As(res.Err, &re) || !errors.Is(res.Err, boom) {
				t.Fatalf("err=%v is not the injected read error", res.Err)
			}
			if errors.Is(res.Err, ErrLimitExceeded) {
				t.Fatal("read error must not be reported as a limit hit")
			}
			want := int64(2 * at)
			if res.Stats.BytesRead != want || res.Dests[0].BytesWritten != want {
				t.Fatalf("accounts: read=%d written=%d want=%d",
					res.Stats.BytesRead, res.Dests[0].BytesWritten, want)
			}
			if src.closes.Load() != 1 {
				t.Fatalf("upstream closed %d times", src.closes.Load())
			}
		})
	}
}

func TestSentPrefixIsNotReportedAsDelivered(t *testing.T) {
	src := &scriptedSource{steps: []step{
		{data: []byte("aaa")},
		{data: []byte("bbb")}, // total 6 > 5: dropped, prefix of 3 already sent
	}}
	d := newRecorder("d")

	res := New(Config{ChunkSize: 4, MaxBytes: 5}).Forward(context.Background(), src, d)

	if res.State == StateDelivered || res.Err == nil {
		t.Fatalf("prefix reported as success: state=%v err=%v", res.State, res.Err)
	}
	if res.State != StateLimitExceeded {
		t.Fatalf("state=%v", res.State)
	}
	if res.Dests[0].BytesWritten != 3 {
		t.Fatalf("dest received %d bytes, want the 3-byte prefix only", res.Dests[0].BytesWritten)
	}
}

// --- write errors ----------------------------------------------------------

func TestWriteErrorPositions(t *testing.T) {
	boom := errors.New("sink boom")
	for at := 0; at <= 2; at++ {
		src := &scriptedSource{steps: []step{
			{data: []byte("aa")}, {data: []byte("bb")}, {data: []byte("cc")},
		}}
		d := newRecorder("d")
		d.failAt, d.failErr = at, boom
		pool := NewPool(8, 16)

		res := New(Config{Pool: pool, QueueDepth: 2}).Forward(context.Background(), src, d)

		if res.State != StateWriteFailed || !errors.Is(res.Err, boom) {
			t.Fatalf("at=%d state=%v err=%v", at, res.State, res.Err)
		}
		want := int64(2 * at)
		if res.Dests[0].BytesWritten != want || res.Dests[0].ChunksWritten != int64(at) {
			t.Fatalf("at=%d dest account: %+v want %d bytes", at, res.Dests[0], want)
		}
		if res.Stats.BytesRead != 6 {
			t.Fatalf("at=%d upstream account: %+v", at, res.Stats)
		}
		// Every chunk lease released: no buffer remains checked out.
		if got := pool.Outstanding(); got != 0 {
			t.Fatalf("at=%d pool outstanding=%d, want 0 (no leaked leases)", at, got)
		}
	}
}

// --- budget barrier --------------------------------------------------------

func TestBudgetBoundary(t *testing.T) {
	cases := []struct {
		max         int64
		state       State
		read, wrote int64
	}{
		{0, StateDelivered, 12, 12},  // unlimited
		{12, StateDelivered, 12, 12}, // exactly on budget
		{11, StateLimitExceeded, 12, 8},
		{4, StateLimitExceeded, 8, 4},
		{1, StateLimitExceeded, 4, 0},
	}
	for _, tc := range cases {
		src := &scriptedSource{steps: []step{
			{data: []byte("aaaa")}, {data: []byte("bbbb")}, {data: []byte("cccc")},
		}}
		d := newRecorder("d")
		res := New(Config{ChunkSize: 4, MaxBytes: tc.max}).Forward(context.Background(), src, d)
		if res.State != tc.state {
			t.Fatalf("max=%d state=%v want %v", tc.max, res.State, tc.state)
		}
		if res.Stats.BytesRead != tc.read || res.Dests[0].BytesWritten != tc.wrote {
			t.Fatalf("max=%d read=%d wrote=%d want %d/%d",
				tc.max, res.Stats.BytesRead, res.Dests[0].BytesWritten, tc.read, tc.wrote)
		}
		if src.closes.Load() != 1 {
			t.Fatalf("max=%d upstream closed %d times", tc.max, src.closes.Load())
		}
	}
}

// --- cancellation ----------------------------------------------------------

func TestCancelUnblocksPendingRead(t *testing.T) {
	src := newBlockingSource()
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan Result, 1)
	go func() { done <- New(Config{ChunkSize: 4}).Forward(ctx, src) }()

	time.Sleep(20 * time.Millisecond) // let Forward block in ReadChunk
	cancel()

	select {
	case res := <-done:
		if res.State != StateCanceled || !errors.Is(res.Err, context.Canceled) {
			t.Fatalf("state=%v err=%v", res.State, res.Err)
		}
		if src.closes.Load() != 1 {
			t.Fatalf("upstream closed %d times", src.closes.Load())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Forward did not return after cancel")
	}
}

func TestCancelDuringInflightWrite(t *testing.T) {
	src := &scriptedSource{steps: []step{{data: []byte("aa")}, {data: []byte("bb")}}}
	sink := newCtxSink()
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan Result, 1)
	go func() { done <- New(Config{ChunkSize: 4}).Forward(ctx, src, sink) }()

	<-sink.entered
	cancel()

	select {
	case res := <-done:
		if res.State != StateCanceled || !errors.Is(res.Err, context.Canceled) {
			t.Fatalf("state=%v err=%v", res.State, res.Err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Forward did not return after cancel")
	}
}

// TestCancelDoesNotOverwriteDelivered races the main response against
// cancellation behind a barrier and verifies a single consistent terminal
// state: delivered means fully accounted, canceled means ctx.Err().
func TestCancelDoesNotOverwriteDelivered(t *testing.T) {
	for i := 0; i < 200; i++ {
		src := &scriptedSource{steps: []step{{data: []byte("x")}}}
		d := newRecorder("d")
		ctx, cancel := context.WithCancel(context.Background())
		barrier := make(chan struct{})

		var res Result
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			res = New(Config{ChunkSize: 4}).Forward(ctx, src, d)
		}()
		go func() { <-barrier; cancel() }()
		close(barrier)
		wg.Wait()

		switch res.State {
		case StateDelivered:
			if res.Stats.BytesRead != 1 || res.Dests[0].BytesWritten != 1 {
				t.Fatalf("delivered but accounts wrong: %+v", res)
			}
		case StateCanceled:
			if !errors.Is(res.Err, context.Canceled) {
				t.Fatalf("canceled with err=%v", res.Err)
			}
		default:
			t.Fatalf("unexpected terminal state %v", res.State)
		}
		cancel()
	}
}

// --- unique terminal state -------------------------------------------------

func TestOutcomeSingleWinner(t *testing.T) {
	var o outcome
	var wg sync.WaitGroup
	states := []State{StateDelivered, StateCanceled, StateLimitExceeded, StateReadFailed}
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			o.trySet(Result{State: states[i%len(states)]})
		}(i)
	}
	wg.Wait()
	if got := o.sets.Load(); got != 1 {
		t.Fatalf("terminal state recorded %d times, want exactly 1", got)
	}
	if o.res.State == StatePending {
		t.Fatal("no terminal state recorded")
	}
}

// --- shared lease across destinations --------------------------------------

func TestDestinationsShareOriginalChunk(t *testing.T) {
	pool := NewPool(4, 16)
	src := &scriptedSource{steps: []step{{data: []byte("ab")}, {data: []byte("cd")}}}

	var mu sync.Mutex
	ptrs := map[int][]uintptr{}
	d1 := &ptrSink{record: func(idx int, p uintptr) {
		mu.Lock()
		ptrs[idx] = append(ptrs[idx], p)
		mu.Unlock()
	}}
	d2 := &ptrSink{record: d1.record}

	res := New(Config{Pool: pool, QueueDepth: 2}).Forward(context.Background(), src, d1, d2)
	if res.State != StateDelivered {
		t.Fatalf("state=%v", res.State)
	}
	for idx, ps := range ptrs {
		if len(ps) != 2 || ps[0] != ps[1] {
			t.Fatalf("chunk %d not shared across destinations: %x", idx, ps)
		}
	}
	if got := pool.Outstanding(); got != 0 {
		t.Fatalf("pool outstanding=%d, want 0 (all leases released)", got)
	}
}

type ptrSink struct {
	idx    int
	record func(idx int, p uintptr)
}

func (s *ptrSink) WriteChunk(_ context.Context, data []byte) error {
	if len(data) > 0 {
		s.record(s.idx, uintptr(unsafe.Pointer(&data[0])))
	}
	s.idx++
	return nil
}

func (s *ptrSink) Close(error) error { return nil }
