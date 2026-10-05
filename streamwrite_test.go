package streamwrite

import (
	"bytes"
	"errors"
	"io"
	"sync"
	"testing"
)

// errRetryable is injected by fake writers to simulate a transient failure
// after a partial accept; callers are expected to retry the remainder.
var errRetryable = errors.New("transient sink failure")

// shortWriter accepts at most maxPerCall bytes per Write and reports err
// alongside the partial count, forcing callers to retry the remainder.
type shortWriter struct {
	buf        bytes.Buffer
	maxPerCall int
	err        error
}

func (s *shortWriter) Write(p []byte) (int, error) {
	if len(p) > s.maxPerCall {
		p = p[:s.maxPerCall]
	}
	n, _ := s.buf.Write(p)
	return n, s.err
}

// writeAll retries the unaccepted remainder until p is fully persisted,
// mirroring the contract a caller of StreamWriter must follow.
func writeAll(t *testing.T, sw *StreamWriter, p []byte) {
	t.Helper()
	for off := 0; off < len(p); {
		n, err := sw.Write(p[off:])
		off += n
		if err == nil {
			continue
		}
		if errors.Is(err, errRetryable) || errors.Is(err, ErrNoProgress) {
			continue
		}
		t.Fatalf("Write(%d remaining bytes): unexpected error %v after %d accepted", len(p)-off+n, err, n)
	}
}

// stream builds a deterministic byte stream of n bytes.
func stream(n int) []byte {
	p := make([]byte, n)
	for i := range p {
		p[i] = byte(i * 31)
	}
	return p
}

func TestShortWriteWithErrorRetryNoDuplication(t *testing.T) {
	data := stream(100_000)
	sink := &shortWriter{maxPerCall: 777, err: errRetryable}
	sw := New(sink)

	writeAll(t, sw, data)

	if got := sink.buf.Bytes(); !bytes.Equal(got, data) {
		t.Fatalf("persisted stream differs from original: got %d bytes, want %d", len(got), len(data))
	}
	if got := sw.BytesPersisted(); got != int64(len(data)) {
		t.Fatalf("BytesPersisted = %d, want %d", got, len(data))
	}
}

func TestShortWriteWithoutError(t *testing.T) {
	data := stream(50_000)
	sink := &shortWriter{maxPerCall: 1} // one byte per call, nil error
	sw := New(sink)

	n, err := sw.Write(data)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if n != len(data) {
		t.Fatalf("Write accepted %d bytes, want %d", n, len(data))
	}
	if !bytes.Equal(sink.buf.Bytes(), data) {
		t.Fatal("persisted stream differs from original")
	}
	if got := sw.BytesPersisted(); got != int64(len(data)) {
		t.Fatalf("BytesPersisted = %d, want %d", got, len(data))
	}
}

// stallWriter returns (0, nil) stallTimes times, then works normally.
type stallWriter struct {
	buf        bytes.Buffer
	stallTimes int
	calls      int
}

func (s *stallWriter) Write(p []byte) (int, error) {
	s.calls++
	if s.stallTimes > 0 {
		s.stallTimes--
		return 0, nil
	}
	return s.buf.Write(p)
}

func TestZeroProgressDoesNotSpin(t *testing.T) {
	sink := &stallWriter{} // permanent stall
	sink.stallTimes = 1 << 30
	sw := New(sink)

	n, err := sw.Write(stream(10))
	if n != 0 || !errors.Is(err, ErrNoProgress) {
		t.Fatalf("Write = (%d, %v), want (0, ErrNoProgress)", n, err)
	}
	if sink.calls != 1 {
		t.Fatalf("underlying writer called %d times, want exactly 1 (no busy spin)", sink.calls)
	}
	if got := sw.BytesPersisted(); got != 0 {
		t.Fatalf("BytesPersisted = %d, want 0", got)
	}
}

func TestZeroProgressThenRecovery(t *testing.T) {
	data := stream(4_096)
	sink := &stallWriter{stallTimes: 5}
	sw := New(sink)

	writeAll(t, sw, data)

	if !bytes.Equal(sink.buf.Bytes(), data) {
		t.Fatal("persisted stream differs from original")
	}
	if got := sw.BytesPersisted(); got != int64(len(data)) {
		t.Fatalf("BytesPersisted = %d, want %d", got, len(data))
	}
}

// brokenWriter violates the io.Writer contract.
type brokenWriter struct{}

func (brokenWriter) Write(p []byte) (int, error) { return len(p) + 1, nil }

func TestInvalidWriteCountRejected(t *testing.T) {
	sw := New(brokenWriter{})
	if n, err := sw.Write(stream(8)); err == nil || n != 0 {
		t.Fatalf("Write = (%d, %v), want (0, invalid-count error)", n, err)
	}
	if got := sw.BytesPersisted(); got != 0 {
		t.Fatalf("BytesPersisted = %d, want 0", got)
	}
}

// closeTrackingBuffer records how many times Close ran.
type closeTrackingBuffer struct {
	mu     sync.Mutex
	buf    bytes.Buffer
	closes int
}

func (c *closeTrackingBuffer) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.Write(p)
}

func (c *closeTrackingBuffer) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closes++
	return nil
}

func TestCloseWriteRaceSingleTerminalState(t *testing.T) {
	for trial := 0; trial < 200; trial++ {
		data := stream(64_000)
		sink := &closeTrackingBuffer{}
		sw := New(sink)

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			for off := 0; off < len(data); {
				n, err := sw.Write(data[off : off+128])
				if errors.Is(err, ErrClosed) {
					return // lost the race: terminal state reached
				}
				if err != nil {
					t.Errorf("Write: unexpected error %v", err)
					return
				}
				off += n
			}
		}()
		go func() {
			defer wg.Done()
			if err := sw.Close(); err != nil {
				t.Errorf("first Close: %v", err)
			}
		}()
		wg.Wait()

		// The persisted bytes must be an exact prefix of the original
		// stream: every racing Write either landed fully or not at all.
		persisted := sink.buf.Bytes()
		if !bytes.Equal(persisted, data[:len(persisted)]) {
			t.Fatalf("trial %d: persisted %d bytes are not a prefix of the original stream", trial, len(persisted))
		}
		if got := sw.BytesPersisted(); got != int64(len(persisted)) {
			t.Fatalf("trial %d: BytesPersisted = %d, want %d", trial, got, len(persisted))
		}
		if sink.closes != 1 {
			t.Fatalf("trial %d: underlying Close ran %d times, want 1", trial, sink.closes)
		}

		// Terminal state is sticky: further Writes and Closes fail.
		if n, err := sw.Write([]byte("x")); n != 0 || !errors.Is(err, ErrClosed) {
			t.Fatalf("trial %d: post-close Write = (%d, %v), want (0, ErrClosed)", trial, n, err)
		}
		if err := sw.Close(); !errors.Is(err, ErrClosed) {
			t.Fatalf("trial %d: second Close = %v, want ErrClosed", trial, err)
		}
		if got := sw.BytesPersisted(); got != int64(len(persisted)) {
			t.Fatalf("trial %d: BytesPersisted changed after close: %d", trial, got)
		}
	}
}

func TestConcurrentClosesExactlyOneWins(t *testing.T) {
	sw := New(&closeTrackingBuffer{})
	const closers = 32

	var wg sync.WaitGroup
	results := make(chan error, closers)
	for i := 0; i < closers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- sw.Close()
		}()
	}
	wg.Wait()
	close(results)

	wins := 0
	for err := range results {
		if err == nil {
			wins++
		} else if !errors.Is(err, ErrClosed) {
			t.Fatalf("Close: unexpected error %v", err)
		}
	}
	if wins != 1 {
		t.Fatalf("%d concurrent Closes succeeded, want exactly 1 terminal transition", wins)
	}
}

func TestWriteAfterCleanClose(t *testing.T) {
	data := stream(1_024)
	sink := &closeTrackingBuffer{}
	sw := New(sink)

	writeAll(t, sw, data)
	if err := sw.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !bytes.Equal(sink.buf.Bytes(), data) {
		t.Fatal("persisted stream differs from original")
	}
	if got := sw.BytesPersisted(); got != int64(len(data)) {
		t.Fatalf("BytesPersisted = %d, want %d", got, len(data))
	}
	if _, err := sw.Write([]byte("more")); !errors.Is(err, ErrClosed) {
		t.Fatalf("Write after Close = %v, want ErrClosed", err)
	}
}

// Compile-time check: StreamWriter itself satisfies io.Writer.
var _ io.Writer = (*StreamWriter)(nil)
