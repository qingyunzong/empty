package groupflush

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

// controlledFile is a scriptable File used to observe batch boundaries.
// It records how many bytes had been written at every Sync, and can
// block, fail, or pass each Sync on demand.
type controlledFile struct {
	mu        sync.Mutex
	data      []byte
	syncErr   error
	writeErr  error
	gated     bool          // when true, every Sync blocks until released
	entered   chan int      // receives the 1-based sync number when Sync starts
	release   chan struct{} // one receive unblocks one Sync
	syncSizes []int         // len(data) observed at each Sync
}

func newControlledFile(gated bool) *controlledFile {
	return &controlledFile{
		gated:   gated,
		entered: make(chan int, 64),
		release: make(chan struct{}),
	}
}

func (c *controlledFile) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.writeErr != nil {
		return 0, c.writeErr
	}
	c.data = append(c.data, p...)
	return len(p), nil
}

func (c *controlledFile) Sync() error {
	c.mu.Lock()
	c.syncSizes = append(c.syncSizes, len(c.data))
	n := len(c.syncSizes)
	gated := c.gated
	c.mu.Unlock()

	if gated {
		c.entered <- n
		<-c.release
	}

	// The scripted error is read after the gate so a test can change the
	// outcome of a blocked Sync deterministically before releasing it.
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.syncErr
}

func (c *controlledFile) waitSync(t *testing.T, n int) {
	t.Helper()
	select {
	case got := <-c.entered:
		if got != n {
			t.Fatalf("sync #%d started, want sync #%d", got, n)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for sync #%d to start", n)
	}
}

func (c *controlledFile) releaseSync() { c.release <- struct{}{} }

func (c *controlledFile) setSyncErr(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.syncErr = err
}

func (c *controlledFile) sizes() []int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]int(nil), c.syncSizes...)
}

func (c *controlledFile) bytes() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.data...)
}

func waitPending(t *testing.T, f *Flusher, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		got := len(f.cur.reqs)
		f.mu.Unlock()
		if got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d pending requests, have %d", want, got)
		}
		time.Sleep(time.Millisecond)
	}
}

func submitAsync(f *Flusher, ctx context.Context, p []byte) <-chan error {
	ch := make(chan error, 1)
	go func() { ch <- f.Submit(ctx, p) }()
	return ch
}

func await(t *testing.T, ch <-chan error) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for Submit to return")
		return nil
	}
}

func requireBlocked(t *testing.T, ch <-chan error, what string) {
	t.Helper()
	select {
	case err := <-ch:
		t.Fatalf("%s confirmed early with %v", what, err)
	case <-time.After(50 * time.Millisecond):
	}
}

// TestSharesOneSync: many callers waiting on the same flush share a single
// fsync.
func TestSharesOneSync(t *testing.T) {
	cf := newControlledFile(true)
	f := New(cf)
	defer f.Close()

	first := submitAsync(f, context.Background(), []byte("AAAA"))
	cf.waitSync(t, 1) // batch 1 = {first}, sync 1 now blocked

	// Five more callers arrive while sync 1 is in flight; all of them
	// must land in batch 2 and share one fsync.
	var shared []<-chan error
	for i := 0; i < 5; i++ {
		shared = append(shared, submitAsync(f, context.Background(), []byte("B")))
	}
	waitPending(t, f, 5)

	cf.releaseSync() // finish sync 1
	if err := await(t, first); err != nil {
		t.Fatalf("first submit: %v", err)
	}
	cf.waitSync(t, 2)
	cf.releaseSync() // finish sync 2, confirming all five
	for i, ch := range shared {
		if err := await(t, ch); err != nil {
			t.Fatalf("shared submit %d: %v", i, err)
		}
	}

	if got := cf.sizes(); len(got) != 2 {
		t.Fatalf("6 callers caused %d fsyncs, want 2 (sizes %v)", len(got), got)
	}
}

// TestBatchSealedBeforeWrite: a submit that arrives after a batch is
// sealed cannot be confirmed by that batch's fsync, and its bytes are not
// covered by it.
func TestBatchSealedBeforeWrite(t *testing.T) {
	cf := newControlledFile(true)
	f := New(cf)
	defer f.Close()

	a := submitAsync(f, context.Background(), []byte("AAAA"))
	cf.waitSync(t, 1) // batch 1 sealed with only AAAA; sync 1 blocked

	b := submitAsync(f, context.Background(), []byte("BBBB"))
	waitPending(t, f, 1) // B queued in the still-open next batch

	cf.releaseSync() // sync 1 completes
	if err := await(t, a); err != nil {
		t.Fatalf("A: %v", err)
	}
	// B must not borrow sync 1 for an early confirmation.
	requireBlocked(t, b, "B")

	cf.waitSync(t, 2)
	cf.releaseSync()
	if err := await(t, b); err != nil {
		t.Fatalf("B: %v", err)
	}

	// Boundary check: sync 1 covered only A's 4 bytes; B's bytes were
	// written afterwards and covered only by sync 2.
	if got, want := cf.sizes(), []int{4, 8}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sync sizes = %v, want %v", got, want)
	}
	if got, want := string(cf.bytes()), "AAAABBBB"; got != want {
		t.Fatalf("file contents = %q, want %q", got, want)
	}
}

// TestSyncFailureAffectsOnlyItsBatch: a failed sync fails exactly the
// callers of that batch; the next batch is a fresh attempt and succeeds.
func TestSyncFailureAffectsOnlyItsBatch(t *testing.T) {
	errBoom := errors.New("boom")
	cf := newControlledFile(true)
	cf.setSyncErr(errBoom)
	f := New(cf)
	defer f.Close()

	a := submitAsync(f, context.Background(), []byte("AAAA"))
	cf.waitSync(t, 1)

	b := submitAsync(f, context.Background(), []byte("BBBB"))
	waitPending(t, f, 1) // B belongs to the next batch

	cf.releaseSync() // sync 1 fails
	if err := await(t, a); !errors.Is(err, errBoom) {
		t.Fatalf("A error = %v, want %v", err, errBoom)
	}

	// Retrying as a new batch is allowed: clear the fault before sync 2
	// returns and B succeeds.
	cf.setSyncErr(nil)
	cf.waitSync(t, 2)
	cf.releaseSync()
	if err := await(t, b); err != nil {
		t.Fatalf("B: %v", err)
	}
}

// TestWriteFailure: a write error fails the batch with that error and
// does not wedge the flusher.
func TestWriteFailure(t *testing.T) {
	errDisk := errors.New("disk on fire")
	cf := newControlledFile(false)
	cf.writeErr = errDisk
	f := New(cf)
	defer f.Close()

	if err := f.Submit(context.Background(), []byte("x")); !errors.Is(err, errDisk) {
		t.Fatalf("submit error = %v, want %v", err, errDisk)
	}

	cf.writeErr = nil
	if err := f.Submit(context.Background(), []byte("ok")); err != nil {
		t.Fatalf("retry after write failure: %v", err)
	}
	if got := string(cf.bytes()); got != "ok" {
		t.Fatalf("file contents = %q, want %q", got, "ok")
	}
}

// TestCancellationIndependence: cancelling one caller neither cancels the
// shared fsync nor affects other callers in the same batch; the cancelled
// caller's bytes are still written and synced.
func TestCancellationIndependence(t *testing.T) {
	cf := newControlledFile(true)
	f := New(cf)
	defer f.Close()

	d := submitAsync(f, context.Background(), []byte("DD"))
	cf.waitSync(t, 1) // sync 1 blocked, batch 2 open

	ctxA, cancelA := context.WithCancel(context.Background())
	a := submitAsync(f, ctxA, []byte("AAAA"))
	waitPending(t, f, 1) // A queued in batch 2
	b := submitAsync(f, context.Background(), []byte("BBBB"))
	waitPending(t, f, 2) // A and B share batch 2, A first

	cancelA()
	if err := await(t, a); !errors.Is(err, context.Canceled) {
		t.Fatalf("A error = %v, want context.Canceled", err)
	}

	cf.releaseSync() // sync 1 done
	if err := await(t, d); err != nil {
		t.Fatalf("D: %v", err)
	}
	cf.waitSync(t, 2)
	requireBlocked(t, b, "B")
	cf.releaseSync() // sync 2 done
	if err := await(t, b); err != nil {
		t.Fatalf("B: %v", err)
	}

	// A's cancellation did not remove its bytes from the batch.
	if got, want := string(cf.bytes()), "DDAAAABBBB"; got != want {
		t.Fatalf("file contents = %q, want %q", got, want)
	}
	if got := cf.sizes(); len(got) != 2 {
		t.Fatalf("sync count = %d, want 2", len(got))
	}
}

// TestSubmitWithCancelledContext: an already-cancelled context is
// rejected without touching the file.
func TestSubmitWithCancelledContext(t *testing.T) {
	cf := newControlledFile(false)
	f := New(cf)
	defer f.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := f.Submit(ctx, []byte("nope")); !errors.Is(err, context.Canceled) {
		t.Fatalf("submit error = %v, want context.Canceled", err)
	}
	if got := cf.bytes(); len(got) != 0 {
		t.Fatalf("file received %q from a cancelled submit", got)
	}
	if got := cf.sizes(); len(got) != 0 {
		t.Fatalf("cancelled submit triggered %d syncs", len(got))
	}
}

// TestClose: Close waits for in-flight batches and rejects new submits.
func TestClose(t *testing.T) {
	cf := newControlledFile(true)
	f := New(cf)

	a := submitAsync(f, context.Background(), []byte("AAAA"))
	cf.waitSync(t, 1)

	closed := make(chan error, 1)
	go func() { closed <- f.Close() }()
	requireBlocked(t, closed, "Close")

	cf.releaseSync()
	if err := await(t, a); err != nil {
		t.Fatalf("A: %v", err)
	}
	if err := await(t, closed); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := f.Submit(context.Background(), []byte("late")); !errors.Is(err, ErrClosed) {
		t.Fatalf("submit after Close = %v, want %v", err, ErrClosed)
	}
}

// TestRealFile: end-to-end sanity check against a real *os.File.
func TestRealFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	osf, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer osf.Close()

	f := New(osf)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := f.Submit(context.Background(), []byte("rec\n")); err != nil {
				t.Errorf("submit: %v", err)
			}
		}()
	}
	wg.Wait()
	if err := f.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := len(data), 16*len("rec\n"); got != want {
		t.Fatalf("file size = %d, want %d", got, want)
	}
}
