package streamfanout

import (
	"bytes"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// bufferCloser records written bytes and counts Close calls.
type bufferCloser struct {
	mu     sync.Mutex
	buf    bytes.Buffer
	closes int32
}

func (b *bufferCloser) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *bufferCloser) Close() error {
	atomic.AddInt32(&b.closes, 1)
	return nil
}

func (b *bufferCloser) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.buf.Bytes()...)
}

// failAfterWriter accepts exactly limit bytes in total, then fails.
type failAfterWriter struct {
	limit int
	err   error
	buf   bytes.Buffer
}

func (f *failAfterWriter) Write(p []byte) (int, error) {
	if f.limit <= 0 {
		return 0, f.err
	}
	if len(p) > f.limit {
		n := f.limit
		f.buf.Write(p[:n])
		f.limit = 0
		return n, f.err
	}
	f.buf.Write(p)
	f.limit -= len(p)
	return len(p), nil
}

// gateWriter blocks in Write until release is closed.
type gateWriter struct {
	release chan struct{}
	entered chan struct{}
	once    sync.Once
	buf     bytes.Buffer
}

func newGateWriter() *gateWriter {
	return &gateWriter{release: make(chan struct{}), entered: make(chan struct{})}
}

func (g *gateWriter) Write(p []byte) (int, error) {
	g.once.Do(func() { close(g.entered) })
	<-g.release
	return g.buf.Write(p)
}

func makeStream(chunks, size int) ([][]byte, []byte) {
	var parts [][]byte
	var all []byte
	for i := 0; i < chunks; i++ {
		p := bytes.Repeat([]byte{byte('a' + i%26)}, size)
		parts = append(parts, p)
		all = append(all, p...)
	}
	return parts, all
}

func writeAll(t *testing.T, mw *MultiWriter, parts [][]byte) {
	t.Helper()
	for _, p := range parts {
		if _, err := mw.Write(p); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}
}

func hasError(errs []DestinationError, dest string, target error) bool {
	for _, e := range errs {
		if e.Destination == dest && errors.Is(e.Err, target) {
			return true
		}
	}
	return false
}

func TestForwardsIdenticalStreamToAll(t *testing.T) {
	primary := &bufferCloser{}
	m0 := &bufferCloser{}
	m1 := &bufferCloser{}
	mw := New(primary, 1<<20, m0, m1)

	parts, all := makeStream(20, 100)
	writeAll(t, mw, parts)
	if err := mw.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	for name, got := range map[string][]byte{
		"primary":   primary.Bytes(),
		"mirror[0]": m0.Bytes(),
		"mirror[1]": m1.Bytes(),
	} {
		if !bytes.Equal(got, all) {
			t.Fatalf("%s received %d bytes, want full %d-byte stream", name, len(got), len(all))
		}
	}
	if errs := mw.Errors(); len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
}

func TestMirrorFailureRecordedAndDoesNotBlockPrimary(t *testing.T) {
	primary := &bufferCloser{}
	failErr := errors.New("mirror disk full")
	broken := &failAfterWriter{limit: 250, err: failErr}
	healthy := &bufferCloser{}
	mw := New(primary, 1<<20, broken, healthy)

	parts, all := makeStream(10, 100) // 1000 bytes; mirror[0] dies at 250
	writeAll(t, mw, parts)
	if err := mw.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if !bytes.Equal(primary.Bytes(), all) {
		t.Fatalf("primary received %d bytes, want %d", len(primary.Bytes()), len(all))
	}
	if !bytes.Equal(healthy.Bytes(), all) {
		t.Fatalf("healthy mirror received %d bytes, want %d", len(healthy.Bytes()), len(all))
	}
	// The failed mirror must hold an exact prefix of the stream.
	if got := broken.buf.Bytes(); !bytes.HasPrefix(all, got) || len(got) != 250 {
		t.Fatalf("broken mirror holds %d bytes, want 250-byte prefix", len(got))
	}
	if !hasError(mw.Errors(), "mirror[0]", failErr) {
		t.Fatalf("mirror failure not enumerated: %v", mw.Errors())
	}
}

func TestPrimaryFailureCancelsEverything(t *testing.T) {
	failErr := errors.New("primary connection reset")
	primary := &failAfterWriter{limit: 200, err: failErr}
	m0 := &bufferCloser{}
	m1 := &bufferCloser{}
	mw := New(primary, 1<<20, m0, m1)

	parts, all := makeStream(10, 100) // primary dies on the 3rd write
	var writeErr error
	for _, p := range parts {
		if _, err := mw.Write(p); err != nil {
			writeErr = err
			break
		}
	}
	if !errors.Is(writeErr, failErr) {
		t.Fatalf("Write error = %v, want %v", writeErr, failErr)
	}

	select {
	case <-mw.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("Done not closed after primary failure")
	}

	// Subsequent writes keep failing with the sticky primary error.
	if _, err := mw.Write([]byte("more")); !errors.Is(err, failErr) {
		t.Fatalf("post-failure Write = %v, want %v", err, failErr)
	}

	if err := mw.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Mirrors were cancelled: each holds only a prefix of what the primary
	// accepted (200 bytes), never anything the primary rejected.
	for name, got := range map[string][]byte{"mirror[0]": m0.Bytes(), "mirror[1]": m1.Bytes()} {
		if !bytes.HasPrefix(all, got) {
			t.Fatalf("%s data is not a prefix of the stream", name)
		}
		if len(got) > 200 {
			t.Fatalf("%s received %d bytes beyond the 200 the primary accepted", name, len(got))
		}
	}
	if !hasError(mw.Errors(), "primary", failErr) {
		t.Fatalf("primary failure not enumerated: %v", mw.Errors())
	}
}

func TestPrimaryBackpressureNotAbsorbedByMirrors(t *testing.T) {
	primary := newGateWriter()
	mirror := &bufferCloser{} // fast mirror with ample buffer
	mw := New(primary, 1<<20, mirror)

	done := make(chan error, 1)
	go func() {
		_, err := mw.Write([]byte("payload"))
		done <- err
	}()

	<-primary.entered // primary is now applying backpressure
	select {
	case <-done:
		t.Fatal("Write returned while primary was blocked: backpressure was absorbed")
	case <-time.After(100 * time.Millisecond):
	}

	close(primary.release)
	if err := <-done; err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if got := mirror.Bytes(); !bytes.Equal(got, []byte("payload")) {
		t.Fatalf("mirror received %q", got)
	}
}

func TestMirrorBufferBoundAndOverflow(t *testing.T) {
	const bufferSize = 64
	primary := &bufferCloser{}
	slow := newGateWriter()
	mw := New(primary, bufferSize, slow)

	parts, all := makeStream(8, 64) // 512 bytes into a 64-byte mirror buffer
	writeAll(t, mw, parts)          // must not block on the stuck mirror

	// The overflow must be recorded while the primary keeps the full stream.
	deadline := time.Now().Add(2 * time.Second)
	for !hasError(mw.Errors(), "mirror[0]", ErrMirrorOverflow) {
		if time.Now().After(deadline) {
			t.Fatalf("overflow not recorded; errors: %v", mw.Errors())
		}
		time.Sleep(time.Millisecond)
	}

	close(slow.release)
	if err := mw.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if !bytes.Equal(primary.Bytes(), all) {
		t.Fatalf("primary received %d bytes, want %d", len(primary.Bytes()), len(all))
	}
	// The mirror may hold at most one in-flight chunk beyond the buffer cap,
	// and whatever it holds must be an exact prefix of the stream.
	got := slow.buf.Bytes()
	if !bytes.HasPrefix(all, got) {
		t.Fatalf("mirror data is not a prefix of the stream")
	}
	if len(got) > 2*bufferSize {
		t.Fatalf("mirror buffered %d bytes, exceeding cap %d plus one chunk", len(got), bufferSize)
	}
}

func TestCloseExactlyOnce(t *testing.T) {
	primary := &bufferCloser{}
	m0 := &bufferCloser{}
	m1 := &bufferCloser{}
	mw := New(primary, 1<<20, m0, m1)

	parts, _ := makeStream(5, 10)
	writeAll(t, mw, parts)

	var wg sync.WaitGroup
	errs := make([]error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = mw.Close()
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("Close call %d: %v", i, err)
		}
	}

	for name, c := range map[string]*bufferCloser{"primary": primary, "mirror[0]": m0, "mirror[1]": m1} {
		if n := atomic.LoadInt32(&c.closes); n != 1 {
			t.Fatalf("%s closed %d times, want exactly 1", name, n)
		}
	}

	if _, err := mw.Write([]byte("x")); !errors.Is(err, ErrClosed) {
		t.Fatalf("Write after Close = %v, want ErrClosed", err)
	}
}

func TestPrefixIntegrityUnderMirrorFailure(t *testing.T) {
	for _, limit := range []int{0, 1, 137, 4096, 10000} {
		t.Run(fmt.Sprintf("limit=%d", limit), func(t *testing.T) {
			primary := &bufferCloser{}
			broken := &failAfterWriter{limit: limit, err: errors.New("boom")}
			mw := New(primary, 1<<20, broken)

			parts, all := makeStream(50, 200)
			writeAll(t, mw, parts)
			if err := mw.Close(); err != nil {
				t.Fatalf("Close: %v", err)
			}
			if !bytes.Equal(primary.Bytes(), all) {
				t.Fatalf("primary corrupted")
			}
			got := broken.buf.Bytes()
			if !bytes.HasPrefix(all, got) {
				t.Fatalf("mirror bytes are not a prefix of the stream")
			}
			if len(got) != limit {
				t.Fatalf("mirror received %d bytes, want %d", len(got), limit)
			}
		})
	}
}

func TestErrorsEnumeratesMultipleFailures(t *testing.T) {
	primary := &bufferCloser{}
	writeFail := &failAfterWriter{limit: 0, err: errors.New("write boom")}
	stuck := newGateWriter()
	mw := New(primary, 8, writeFail, stuck)

	parts, _ := makeStream(4, 64)
	writeAll(t, mw, parts)

	deadline := time.Now().Add(2 * time.Second)
	for len(mw.Errors()) < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("want 2 recorded failures, got %v", mw.Errors())
		}
		time.Sleep(time.Millisecond)
	}
	close(stuck.release)
	if err := mw.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	errs := mw.Errors()
	if !hasError(errs, "mirror[0]", errors.New("write boom")) && errs[0].Destination != "mirror[0]" {
		t.Fatalf("mirror[0] failure missing: %v", errs)
	}
	if !hasError(errs, "mirror[1]", ErrMirrorOverflow) {
		t.Fatalf("mirror[1] overflow missing: %v", errs)
	}
	for _, e := range errs {
		if e.Destination == "primary" {
			t.Fatalf("primary must be unaffected, got %v", e)
		}
	}
}

func TestNewPanicsOnInvalidConfig(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for non-positive buffer with mirrors")
		}
	}()
	New(&bufferCloser{}, 0, &bufferCloser{})
}
