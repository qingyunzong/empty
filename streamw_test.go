package streamw_test

import (
	"bytes"
	"errors"
	"io"
	"sync"
	"testing"

	"streamw"
)

// shortWriter accepts at most max bytes per call and records what it got.
type shortWriter struct {
	buf bytes.Buffer
	max int
}

func (s *shortWriter) Write(p []byte) (int, error) {
	if len(p) > s.max {
		p = p[:s.max]
	}
	return s.buf.Write(p)
}

// flakyWriter fails with errBusy without progress a fixed number of times,
// then accepts everything.
type flakyWriter struct {
	buf     bytes.Buffer
	stalls  int
	errBusy error
}

func (f *flakyWriter) Write(p []byte) (int, error) {
	if f.stalls > 0 {
		f.stalls--
		return 0, f.errBusy
	}
	return f.buf.Write(p)
}

// chunkWriter accepts a random-length prefix (1..max) per call, like a
// stream with backpressure. Safe for concurrent use via the library mutex.
type chunkWriter struct {
	buf bytes.Buffer
	max int
}

func (c *chunkWriter) Write(p []byte) (int, error) {
	n := 1 + ((c.buf.Len() | len(p)) % c.max) // deterministic pseudo-random 1..max
	if n > len(p) {
		n = len(p)
	}
	return c.buf.Write(p[:n])
}

type closeRecorder struct {
	buf        bytes.Buffer
	closeCount int
}

func (c *closeRecorder) Write(p []byte) (int, error) { return c.buf.Write(p) }
func (c *closeRecorder) Close() error {
	c.closeCount++
	return nil
}

func makeStream(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i*31 + 7)
	}
	return b
}

// TestShortWriteRetry: Write accepts a prefix; the caller retries p[n:] and
// the persisted bytes must equal the original stream with no duplicated
// prefix.
func TestShortWriteRetry(t *testing.T) {
	under := &shortWriter{max: 3}
	w := streamw.New(under)
	want := makeStream(1000)

	n, err := streamw.WriteAll(w, want, 8)
	if err != nil {
		t.Fatalf("WriteAll: %v", err)
	}
	if n != len(want) {
		t.Fatalf("wrote %d bytes, want %d", n, len(want))
	}
	if got := w.Persisted(); got != int64(len(want)) {
		t.Fatalf("Persisted = %d, want %d", got, len(want))
	}
	if !bytes.Equal(under.buf.Bytes(), want) {
		t.Fatal("persisted bytes differ from original stream")
	}
}

// TestShortWriteNilError: a short count with nil error from the underlying
// writer surfaces as io.ErrShortWrite and only the prefix is counted.
func TestShortWriteNilError(t *testing.T) {
	under := &shortWriter{max: 4}
	w := streamw.New(under)
	p := makeStream(10)

	n, err := w.Write(p)
	if !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("err = %v, want io.ErrShortWrite", err)
	}
	if n != 4 {
		t.Fatalf("n = %d, want 4", n)
	}
	if got := w.Persisted(); got != 4 {
		t.Fatalf("Persisted = %d, want 4", got)
	}
	if !bytes.Equal(under.buf.Bytes(), p[:4]) {
		t.Fatal("persisted prefix differs from original")
	}
}

// TestZeroProgressStall: WriteAll aborts with io.ErrNoProgress after
// maxZeroProgress consecutive zero-byte calls, persisting nothing.
func TestZeroProgressStall(t *testing.T) {
	under := &flakyWriter{stalls: 100, errBusy: errors.New("busy")}
	w := streamw.New(under)
	p := makeStream(64)

	n, err := streamw.WriteAll(w, p, 5)
	if n != 0 {
		t.Fatalf("n = %d, want 0", n)
	}
	if err == nil {
		t.Fatal("expected error after zero-progress stall")
	}
	if got := w.Persisted(); got != 0 {
		t.Fatalf("Persisted = %d, want 0", got)
	}
	if under.buf.Len() != 0 {
		t.Fatal("nothing should reach the underlying writer")
	}
}

// TestZeroProgressRecovery: a writer that stalls briefly then recovers lets
// WriteAll finish; the persisted stream matches the original exactly.
func TestZeroProgressRecovery(t *testing.T) {
	under := &flakyWriter{stalls: 3, errBusy: errors.New("busy")}
	w := streamw.New(under)
	want := makeStream(256)

	n, err := streamw.WriteAll(w, want, 8)
	if err != nil {
		t.Fatalf("WriteAll: %v", err)
	}
	if n != len(want) || !bytes.Equal(under.buf.Bytes(), want) {
		t.Fatal("persisted stream differs from original")
	}
	if got := w.Persisted(); got != int64(len(want)) {
		t.Fatalf("Persisted = %d, want %d", got, len(want))
	}
}

// TestWriteAfterClose: a closed writer accepts nothing.
func TestWriteAfterClose(t *testing.T) {
	under := &shortWriter{max: 1 << 20}
	w := streamw.New(under)
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	n, err := w.Write(makeStream(8))
	if !errors.Is(err, streamw.ErrClosed) {
		t.Fatalf("err = %v, want ErrClosed", err)
	}
	if n != 0 || w.Persisted() != 0 || under.buf.Len() != 0 {
		t.Fatal("write after close persisted bytes")
	}
}

// TestCloseExactlyOnce: concurrent Close calls yield exactly one terminal
// transition; the underlying closer runs once.
func TestCloseExactlyOnce(t *testing.T) {
	under := &closeRecorder{}
	w := streamw.New(under)

	const closers = 32
	var wg sync.WaitGroup
	nils := make(chan struct{}, closers)
	for i := 0; i < closers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := w.Close(); err == nil {
				nils <- struct{}{}
			} else if !errors.Is(err, streamw.ErrClosed) {
				t.Errorf("unexpected close error: %v", err)
			}
		}()
	}
	wg.Wait()
	close(nils)

	count := 0
	for range nils {
		count++
	}
	if count != 1 {
		t.Fatalf("%d goroutines saw successful close, want exactly 1", count)
	}
	if under.closeCount != 1 {
		t.Fatalf("underlying Close ran %d times, want 1", under.closeCount)
	}
}

// TestCloseWriteRace: one goroutine streams bytes with retries while others
// race Close. The persisted bytes must be an exact prefix of the original
// stream — no duplication, no gaps — and Persisted must match the byte count.
func TestCloseWriteRace(t *testing.T) {
	for trial := 0; trial < 20; trial++ {
		under := &chunkWriter{max: 7}
		w := streamw.New(under)
		want := makeStream(4096)

		done := make(chan struct{})
		go func() {
			defer close(done)
			streamw.WriteAll(w, want, 16) // ErrClosed ends the stream
		}()
		go func() {
			for i := 0; i < 3; i++ {
				w.Close() // only the first takes effect
			}
		}()
		<-done

		persisted := under.buf.Bytes()
		if int64(len(persisted)) != w.Persisted() {
			t.Fatalf("trial %d: Persisted = %d, underlying has %d bytes",
				trial, w.Persisted(), len(persisted))
		}
		if !bytes.Equal(persisted, want[:len(persisted)]) {
			t.Fatalf("trial %d: persisted bytes are not a prefix of the original stream", trial)
		}
	}
}

// TestInvalidWriteCount: an underlying writer reporting n > len(p) is
// rejected without corrupting the persisted count.
func TestInvalidWriteCount(t *testing.T) {
	w := streamw.New(badWriter{})
	n, err := w.Write(makeStream(4))
	if err == nil {
		t.Fatal("expected error for invalid write count")
	}
	if n != 0 || w.Persisted() != 0 {
		t.Fatal("invalid write must not affect persisted count")
	}
}

type badWriter struct{}

func (badWriter) Write(p []byte) (int, error) { return len(p) + 1, nil }
