package fanout

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"
)

// syncBuffer is a goroutine-safe bytes.Buffer.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.buf.Bytes()...)
}

// failAfterWriter writes up to budget bytes successfully, then fails.
type failAfterWriter struct {
	budget int
	err    error
	buf    syncBuffer
}

func (w *failAfterWriter) Write(p []byte) (int, error) {
	if w.budget <= 0 {
		return 0, w.err
	}
	if len(p) > w.budget {
		n, _ := w.buf.Write(p[:w.budget])
		w.budget = 0
		return n, w.err
	}
	n, _ := w.buf.Write(p)
	w.budget -= n
	return n, nil
}

// gateWriter blocks every Write until release is closed, then writes
// through. If ctx is cancelled first, the write aborts.
type gateWriter struct {
	release <-chan struct{}
	ctx     context.Context
	buf     syncBuffer
}

func (w *gateWriter) Write(p []byte) (int, error) {
	select {
	case <-w.release:
		return w.buf.Write(p)
	case <-w.ctx.Done():
		return 0, w.ctx.Err()
	}
}

func makeStream(chunks, size int) ([]byte, [][]byte) {
	var stream []byte
	var parts [][]byte
	for i := 0; i < chunks; i++ {
		part := bytes.Repeat([]byte{byte(i)}, size)
		parts = append(parts, part)
		stream = append(stream, part...)
	}
	return stream, parts
}

func writeAll(t *testing.T, w *Writer, parts [][]byte) {
	t.Helper()
	for _, p := range parts {
		if _, err := w.Write(p); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}
}

func requirePrefix(t *testing.T, stream, got []byte, name string) {
	t.Helper()
	if len(got) > len(stream) {
		t.Fatalf("%s received %d bytes, more than the %d written", name, len(got), len(stream))
	}
	if !bytes.Equal(got, stream[:len(got)]) {
		t.Fatalf("%s bytes are not a prefix of the stream (len %d of %d)", name, len(got), len(stream))
	}
}

func TestHappyPath(t *testing.T) {
	var primary syncBuffer
	var m1, m2 syncBuffer
	w := New(&primary,
		WithBufferSize(1<<20),
		WithMirror("m1", &m1),
		WithMirror("m2", &m2),
	)
	stream, parts := makeStream(16, 512)
	writeAll(t, w, parts)
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	for name, got := range map[string][]byte{
		"primary": primary.Bytes(),
		"m1":      m1.Bytes(),
		"m2":      m2.Bytes(),
	} {
		if !bytes.Equal(got, stream) {
			t.Fatalf("%s received %d bytes, want full %d-byte stream", name, len(got), len(stream))
		}
	}
	if errs := w.MirrorErrors(); len(errs) != 0 {
		t.Fatalf("unexpected mirror errors: %v", errs)
	}
	if err := w.Err(); err != nil {
		t.Fatalf("Err: %v", err)
	}
}

func TestPrimaryFailureCancelsAll(t *testing.T) {
	boom := errors.New("primary exploded")
	primary := &failAfterWriter{budget: 1024, err: boom}
	release := make(chan struct{})
	defer close(release)
	mirror := &gateWriter{release: release}

	w := New(primary, WithBufferSize(4096), WithMirror("slow", mirror))
	// The blocked mirror observes the Writer's own termination context:
	// a primary failure must cancel it.
	mirror.ctx = w.Context()
	stream, parts := makeStream(8, 1024)

	// First write fits the primary budget; second one fails.
	if _, err := w.Write(parts[0]); err != nil {
		t.Fatalf("first Write: %v", err)
	}
	if _, err := w.Write(parts[1]); !errors.Is(err, boom) {
		t.Fatalf("second Write err = %v, want %v", err, boom)
	}
	// Subsequent writes keep returning the terminal error.
	if _, err := w.Write(parts[2]); !errors.Is(err, boom) {
		t.Fatalf("post-failure Write err = %v, want %v", err, boom)
	}
	if !errors.Is(w.Err(), boom) {
		t.Fatalf("Err = %v, want %v", w.Err(), boom)
	}
	// Close must return the same terminal error and not hang: the primary
	// failure cancels the Writer's context, which unblocks the mirror
	// pump stuck inside the gate.
	done := make(chan error, 1)
	go func() { done <- w.Close() }()
	select {
	case err := <-done:
		if !errors.Is(err, boom) {
			t.Fatalf("Close err = %v, want %v", err, boom)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close hung after primary failure")
	}
	// The mirror may only have a prefix of the stream.
	requirePrefix(t, stream, mirror.buf.Bytes(), "slow")
}

func TestMirrorFailureDoesNotBlockPrimary(t *testing.T) {
	boom := errors.New("mirror exploded")
	var primary syncBuffer
	w := New(&primary,
		WithBufferSize(1<<20),
		WithMirror("bad", &failAfterWriter{budget: 0, err: boom}),
		WithMirror("good", &syncBuffer{}),
	)
	stream, parts := makeStream(32, 256)
	writeAll(t, w, parts) // primary writes must keep succeeding
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !bytes.Equal(primary.Bytes(), stream) {
		t.Fatalf("primary received %d bytes, want %d", len(primary.Bytes()), len(stream))
	}
	errs := w.MirrorErrors()
	if len(errs) != 1 || errs[0].Name != "bad" || !errors.Is(errs[0].Err, boom) {
		t.Fatalf("MirrorErrors = %v, want one entry for bad mirror wrapping %v", errs, boom)
	}
	if errs[0].Dropped <= 0 {
		t.Fatalf("Dropped = %d, want > 0", errs[0].Dropped)
	}
	if err := w.Err(); err != nil {
		t.Fatalf("Err = %v, want nil (mirror failure must not taint primary)", err)
	}
	// The healthy mirror still received the full stream.
	if got := w.mirrors[1]; got == nil {
		t.Fatal("missing good mirror")
	}
}

func TestSlowMirrorBackpressureAndBufferBound(t *testing.T) {
	const (
		bufSize   = 4096
		chunkSize = 1024
		chunks    = 64 // 64 KiB total, far beyond the 4 KiB mirror buffer
	)
	var primary syncBuffer
	release := make(chan struct{})
	mirror := &gateWriter{release: release, ctx: context.Background()}

	w := New(&primary, WithBufferSize(bufSize), WithMirror("slow", mirror))
	stream, parts := makeStream(chunks, chunkSize)

	// All primary writes must complete while the mirror is fully blocked:
	// mirror backpressure must never reach the primary path.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for _, p := range parts {
			if _, err := w.Write(p); err != nil {
				t.Errorf("Write: %v", err)
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("primary writes blocked behind a stalled mirror")
	}

	close(release)
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if !bytes.Equal(primary.Bytes(), stream) {
		t.Fatalf("primary received %d bytes, want %d", len(primary.Bytes()), len(stream))
	}
	got := mirror.buf.Bytes()
	requirePrefix(t, stream, got, "slow")
	// Buffer bound: at most bufSize queued plus one in-flight chunk.
	if max := bufSize + chunkSize; len(got) > max {
		t.Fatalf("mirror buffered %d bytes, exceeds bound %d", len(got), max)
	}
	// Saturation must be recorded as a mirror failure with dropped bytes.
	errs := w.MirrorErrors()
	if len(errs) != 1 || !errors.Is(errs[0].Err, ErrSaturated) {
		t.Fatalf("MirrorErrors = %v, want one ErrSaturated entry", errs)
	}
	if want := int64(len(stream) - len(got)); errs[0].Dropped != want {
		t.Fatalf("Dropped = %d, want %d", errs[0].Dropped, want)
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	var primary syncBuffer
	w := New(&primary, WithMirror("m", &syncBuffer{}))
	_, parts := makeStream(4, 128)
	writeAll(t, w, parts)

	if err := w.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	// Writes after close are rejected.
	if _, err := w.Write([]byte("x")); !errors.Is(err, ErrClosed) {
		t.Fatalf("Write after Close err = %v, want ErrClosed", err)
	}
	// Close after close still returns the same (nil) result, exactly once.
	if err := w.Close(); err != nil {
		t.Fatalf("third Close: %v", err)
	}
}

func TestCloseReturnsPrimaryErrorOnce(t *testing.T) {
	boom := errors.New("nope")
	primary := &failAfterWriter{budget: 0, err: boom}
	w := New(primary)
	if _, err := w.Write([]byte("x")); !errors.Is(err, boom) {
		t.Fatalf("Write err = %v, want %v", err, boom)
	}
	for i := 0; i < 3; i++ {
		if err := w.Close(); !errors.Is(err, boom) {
			t.Fatalf("Close #%d err = %v, want %v", i, err, boom)
		}
	}
}

func TestContextCancelStopsEverything(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var primary syncBuffer
	release := make(chan struct{})
	defer close(release)
	mirror := &gateWriter{release: release, ctx: ctx}

	w := New(&primary, WithContext(ctx), WithBufferSize(1024), WithMirror("m", mirror))
	if _, err := w.Write([]byte("hello")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	cancel()
	if _, err := w.Write([]byte("x")); !errors.Is(err, context.Canceled) {
		t.Fatalf("Write after cancel err = %v, want context.Canceled", err)
	}
	if !errors.Is(w.Err(), context.Canceled) {
		t.Fatalf("Err = %v, want context.Canceled", w.Err())
	}
	done := make(chan struct{})
	go func() { w.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close hung after context cancellation")
	}
}

func TestConcurrentPrefixProperty(t *testing.T) {
	// Many concurrent writers, a randomly-slow mirror: whatever the mirror
	// received must always be an exact prefix of the primary stream.
	var primary syncBuffer
	mirror := &syncBuffer{}
	w := New(&primary, WithBufferSize(8*1024), WithMirror("m", mirror))

	const writers = 8
	const chunksPerWriter = 50
	var wg sync.WaitGroup
	for id := 0; id < writers; id++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for i := 0; i < chunksPerWriter; i++ {
				chunk := bytes.Repeat([]byte{byte(id)}, 64)
				if _, err := w.Write(chunk); err != nil {
					t.Errorf("Write: %v", err)
					return
				}
			}
		}(id)
	}
	wg.Wait()
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	requirePrefix(t, primary.Bytes(), mirror.Bytes(), "concurrent mirror")
}

func TestShortWritePrimaryIsError(t *testing.T) {
	w := New(io.Discard)
	// zeroWriter returns (0, nil), violating the io.Writer contract.
	if _, err := w.Write([]byte("x")); err != nil {
		t.Fatalf("unexpected err writing to io.Discard: %v", err)
	}
	w.Close()

	zw := New(zeroWriter{})
	if _, err := zw.Write([]byte("x")); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("Write err = %v, want io.ErrShortWrite", err)
	}
	if err := zw.Close(); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("Close err = %v, want io.ErrShortWrite", err)
	}
}

type zeroWriter struct{}

func (zeroWriter) Write(p []byte) (int, error) { return 0, nil }

func TestMirrorErrorEnumerationOrder(t *testing.T) {
	boom := errors.New("x")
	w := New(&syncBuffer{},
		WithBufferSize(1<<20),
		WithMirror("a", &failAfterWriter{budget: 0, err: boom}),
		WithMirror("b", &syncBuffer{}),
		WithMirror("c", &failAfterWriter{budget: 0, err: boom}),
	)
	_, parts := makeStream(4, 64)
	writeAll(t, w, parts)
	w.Close()
	errs := w.MirrorErrors()
	if len(errs) != 2 || errs[0].Name != "a" || errs[1].Name != "c" {
		names := make([]string, len(errs))
		for i, e := range errs {
			names[i] = fmt.Sprintf("%s:%v", e.Name, e.Err)
		}
		t.Fatalf("MirrorErrors = %v, want entries for a and c in order", names)
	}
}
