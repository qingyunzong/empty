package formal

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

var (
	errInjectedSync = errors.New("injected fsync failure")
	errPowerLoss    = errors.New("injected power loss")
)

// faultDevice models a block device with a volatile write cache. WriteAt
// changes only the volatile image. Sync atomically publishes the volatile
// image unless a fault is injected. Crash discards volatile bytes.
type faultDevice struct {
	mu       sync.Mutex
	durable  []byte
	volatile []byte

	maxWrite    int
	stallWrites map[int]bool
	failSync    map[int]error
	crashAtSync int
	crashed     bool
	writeCount  int
	syncCount   int
	syncGate    chan struct{}
	syncEntered chan struct{}
}

func newFaultDevice(size int) *faultDevice {
	return &faultDevice{
		durable:  make([]byte, size),
		volatile: make([]byte, size),
	}
}

func (d *faultDevice) ReadAt(p []byte, off int64) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if off < 0 || off > int64(len(d.durable)) {
		return 0, io.EOF
	}
	n := copy(p, d.durable[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func (d *faultDevice) WriteAt(p []byte, off int64) (int, error) {
	d.mu.Lock()
	attempt := d.writeCount + 1
	d.writeCount++
	if d.crashed {
		d.mu.Unlock()
		return 0, errPowerLoss
	}
	if d.stallWrites[attempt] {
		d.mu.Unlock()
		return 0, nil
	}
	if off < 0 || off > int64(len(d.volatile)) {
		d.mu.Unlock()
		return 0, errors.New("write past device")
	}
	n := len(p)
	if d.maxWrite > 0 && n > d.maxWrite {
		n = d.maxWrite
	}
	if room := len(d.volatile) - int(off); n > room {
		n = room
	}
	copy(d.volatile[off:], p[:n])
	d.mu.Unlock()

	if n < len(p) {
		return n, nil
	}
	return n, nil
}

func (d *faultDevice) Sync() error {
	d.mu.Lock()
	attempt := d.syncCount + 1
	d.syncCount++
	syncErr := d.failSync[attempt]
	crash := d.crashAtSync == attempt
	gate := d.syncGate
	entered := d.syncEntered
	d.mu.Unlock()

	if entered != nil {
		select {
		case entered <- struct{}{}:
		default:
		}
	}
	if gate != nil {
		<-gate
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	if d.crashed {
		return errPowerLoss
	}
	if crash {
		d.crashed = true
		copy(d.volatile, d.durable)
		return errPowerLoss
	}
	if syncErr != nil {
		return syncErr
	}
	copy(d.durable, d.volatile)
	return nil
}

func (d *faultDevice) Size() (int64, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return int64(len(d.durable)), nil
}

func (d *faultDevice) Crash() {
	d.mu.Lock()
	d.crashed = true
	copy(d.volatile, d.durable)
	d.mu.Unlock()
}

func (d *faultDevice) counts() (writes, syncs int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.writeCount, d.syncCount
}

func (d *faultDevice) clearFaults() {
	d.mu.Lock()
	d.stallWrites = nil
	d.failSync = nil
	d.crashAtSync = 0
	d.mu.Unlock()
}

func recoveredSet(t *testing.T, dev *faultDevice, capacity int64) map[uint64]string {
	t.Helper()
	res, err := Recover(dev, capacity)
	if err != nil {
		t.Fatalf("Recover: %v", err)
	}
	got := make(map[uint64]string, len(res.Records))
	var last LSN
	for _, rec := range res.Records {
		if rec.StartLSN < last {
			t.Fatalf("records are not in LSN order: %d after %d", rec.StartLSN, last)
		}
		last = rec.EndLSN
		if rec.EndLSN > res.DurableLSN {
			t.Fatalf("record end %d exceeds durable LSN %d", rec.EndLSN, res.DurableLSN)
		}
		if _, exists := got[rec.TransactionID]; exists {
			t.Fatalf("duplicate transaction %d recovered", rec.TransactionID)
		}
		got[rec.TransactionID] = string(rec.Payload)
	}
	return got
}

func TestGroupCommitSharesWritesAndSync(t *testing.T) {
	const (
		capacity = 4 << 20
		n        = 128
	)
	dev := newFaultDevice(capacity)
	dev.syncGate = make(chan struct{})
	dev.syncEntered = make(chan struct{}, 4)
	g, err := OpenGroupCommitter(dev, capacity)
	if err != nil {
		t.Fatal(err)
	}

	first := make(chan error, 1)
	go func() {
		_, err := g.Commit(context.Background(), 1, []byte("first"))
		first <- err
	}()
	<-dev.syncEntered

	start := make(chan struct{})
	var wg sync.WaitGroup
	var mu sync.Mutex
	acked := map[uint64]string{1: "first"}
	for i := 1; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			txID := uint64(i + 1)
			payload := []byte(fmt.Sprintf("tx-%03d", txID))
			res, err := g.Commit(context.Background(), txID, payload)
			if err != nil {
				t.Errorf("Commit(%d): %v", txID, err)
				return
			}
			mu.Lock()
			acked[txID] = string(payload)
			mu.Unlock()
			if res.EndLSN > g.DurableLSN() {
				t.Errorf("acknowledged end LSN %d above durable %d", res.EndLSN, g.DurableLSN())
			}
		}(i)
	}
	close(start)
	waitUntil(t, "all but the first claimed commit queued", func() bool {
		g.mu.Lock()
		defer g.mu.Unlock()
		return len(g.pending) >= n-1
	})
	close(dev.syncGate)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	wg.Wait()

	if _, syncs := dev.counts(); syncs >= n/2 {
		t.Fatalf("group commit did not share fsyncs: %d syncs for %d commits", syncs, n)
	}
	if err := g.Close(); err != nil {
		t.Fatal(err)
	}
	dev.Crash()
	got := recoveredSet(t, dev, capacity)
	assertSets(t, acked, got)
}

func TestShortWritesAndFailedSyncDoNotAdvanceDurableLSN(t *testing.T) {
	const capacity = 1 << 20
	dev := newFaultDevice(capacity)
	dev.maxWrite = 5
	dev.failSync = map[int]error{2: errInjectedSync}
	g, err := OpenGroupCommitter(dev, capacity)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := g.Commit(context.Background(), 1, bytes.Repeat([]byte("a"), 400)); err != nil {
		t.Fatalf("first commit should survive short writes: %v", err)
	}
	firstDurable := g.DurableLSN()
	if _, err := g.Commit(context.Background(), 2, bytes.Repeat([]byte("b"), 300)); !errors.Is(err, errInjectedSync) {
		t.Fatalf("second commit error = %v, want injected fsync failure", err)
	}
	if got := g.DurableLSN(); got != firstDurable {
		t.Fatalf("durable LSN advanced on fsync failure: %d -> %d", firstDurable, got)
	}

	// Keep going after the failure. The failed group's bytes may still be in
	// the volatile image; the next successful group must not expose them.
	if _, err := g.Commit(context.Background(), 3, []byte("ok")); err != nil {
		t.Fatal(err)
	}
	acked := map[uint64]string{
		1: string(bytes.Repeat([]byte("a"), 400)),
		3: "ok",
	}
	if err := g.Close(); err != nil {
		t.Fatal(err)
	}
	dev.Crash()
	got := recoveredSet(t, dev, capacity)
	assertSets(t, acked, got)
}

func TestZeroProgressWriteFailsWithoutAdvancing(t *testing.T) {
	const capacity = 1 << 20
	dev := newFaultDevice(capacity)
	dev.stallWrites = map[int]bool{1: true}
	g, err := OpenGroupCommitter(dev, capacity)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Commit(context.Background(), 1, []byte("never durable")); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("commit error = %v, want io.ErrShortWrite", err)
	}
	if got := g.DurableLSN(); got != 0 {
		t.Fatalf("durable LSN advanced to %d after zero-progress write", got)
	}
	dev.clearFaults()
	if _, err := g.Commit(context.Background(), 2, []byte("durable")); err != nil {
		t.Fatal(err)
	}
	if err := g.Close(); err != nil {
		t.Fatal(err)
	}
	dev.Crash()
	got := recoveredSet(t, dev, capacity)
	assertSets(t, map[uint64]string{2: "durable"}, got)
}

func TestCanceledWaiterDoesNotWriteOrBecomeVisible(t *testing.T) {
	const capacity = 1 << 20
	dev := newFaultDevice(capacity)
	dev.syncGate = make(chan struct{})
	dev.syncEntered = make(chan struct{}, 4)
	g, err := OpenGroupCommitter(dev, capacity)
	if err != nil {
		t.Fatal(err)
	}

	first := make(chan error, 1)
	go func() {
		_, err := g.Commit(context.Background(), 1, []byte("one"))
		first <- err
	}()
	<-dev.syncEntered

	ctxCancel, cancel := context.WithCancel(context.Background())
	canceled := make(chan error, 1)
	go func() {
		_, err := g.Commit(ctxCancel, 2, []byte("cancel-me"))
		canceled <- err
	}()
	waitUntil(t, "canceled commit queued", func() bool {
		g.mu.Lock()
		defer g.mu.Unlock()
		return len(g.pending) == 1
	})
	cancel()
	if err := <-canceled; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled commit error = %v, want context.Canceled", err)
	}
	if got := g.DurableLSN(); got != 0 {
		t.Fatalf("canceled waiter advanced durable LSN to %d", got)
	}

	close(dev.syncGate)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	beforeWrites, _ := dev.counts()
	canceledCtx, cancelNow := context.WithCancel(context.Background())
	cancelNow()
	if _, err := g.Commit(canceledCtx, 4, []byte("pre-canceled")); !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-canceled commit error = %v", err)
	}
	afterWrites, _ := dev.counts()
	if afterWrites != beforeWrites {
		t.Fatalf("pre-canceled commit performed %d writes", afterWrites-beforeWrites)
	}

	if _, err := g.Commit(context.Background(), 3, []byte("three")); err != nil {
		t.Fatal(err)
	}
	if err := g.Close(); err != nil {
		t.Fatal(err)
	}
	dev.Crash()
	got := recoveredSet(t, dev, capacity)
	assertSets(t, map[uint64]string{1: "one", 3: "three"}, got)
}

func TestCrashDuringSyncAckSetEqualsRecoveredSet(t *testing.T) {
	const capacity = 4 << 20
	for _, crashAt := range []int{1, 2, 5, 9} {
		t.Run(fmt.Sprintf("crash-at-sync-%d", crashAt), func(t *testing.T) {
			const n = 80
			dev := newFaultDevice(capacity)
			dev.crashAtSync = crashAt
			g, err := OpenGroupCommitter(dev, capacity)
			if err != nil {
				t.Fatal(err)
			}
			// Force several groups so a crash can land between them even
			// when all submitters arrive at once.
			g.SetMaxGroupBytes(180)

			var wg sync.WaitGroup
			var mu sync.Mutex
			acked := make(map[uint64]string)
			for i := 0; i < n; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					txID := uint64(i + 1)
					payload := fmt.Sprintf("payload-%03d", txID)
					_, err := g.Commit(context.Background(), txID, []byte(payload))
					if err == nil {
						mu.Lock()
						acked[txID] = payload
						mu.Unlock()
					}
				}(i)
			}
			wg.Wait()
			if err := g.Close(); err != nil {
				t.Fatal(err)
			}
			dev.Crash()
			got := recoveredSet(t, dev, capacity)
			assertSets(t, acked, got)
			if len(acked) == n {
				t.Fatalf("test did not exercise the injected crash")
			}
		})
	}
}

func TestRandomShortWritesAndSyncFailures(t *testing.T) {
	const capacity = 8 << 20
	for seed := 1; seed <= 12; seed++ {
		t.Run(fmt.Sprintf("seed-%d", seed), func(t *testing.T) {
			const n = 120
			dev := newFaultDevice(capacity)
			dev.maxWrite = 3 + (seed*7)%29
			dev.failSync = map[int]error{}
			for attempt := 2; attempt < 40; attempt += 3 + seed%4 {
				dev.failSync[attempt] = errInjectedSync
			}
			g, err := OpenGroupCommitter(dev, capacity)
			if err != nil {
				t.Fatal(err)
			}
			g.SetMaxGroupBytes(int64(250 + seed*37))

			var wg sync.WaitGroup
			var mu sync.Mutex
			acked := make(map[uint64]string)
			for i := 0; i < n; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					txID := uint64(i + 1)
					payload := bytes.Repeat([]byte{byte(i)}, 20+i%90)
					ctx := context.Background()
					var cancel context.CancelFunc
					if i%17 == 0 {
						ctx, cancel = context.WithCancel(ctx)
						cancel() // deterministic pre-cancel: never acknowledged
					}
					_, err := g.Commit(ctx, txID, payload)
					if cancel != nil {
						cancel()
					}
					if err == nil {
						mu.Lock()
						acked[txID] = string(payload)
						mu.Unlock()
					}
				}(i)
			}
			wg.Wait()
			if err := g.Close(); err != nil {
				t.Fatal(err)
			}
			dev.Crash()
			got := recoveredSet(t, dev, capacity)
			assertSets(t, acked, got)
		})
	}
}

func TestLogFullDoesNotStopWriter(t *testing.T) {
	const capacity = 200
	dev := newFaultDevice(capacity)
	g, err := OpenGroupCommitter(dev, capacity)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Commit(context.Background(), 1, bytes.Repeat([]byte("x"), 50)); err != nil {
		t.Fatal(err)
	}
	for txID := uint64(2); txID <= 4; txID++ {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, err := g.Commit(ctx, txID, []byte("does-not-fit"))
		cancel()
		if !errors.Is(err, ErrLogFull) {
			t.Fatalf("Commit(%d) error = %v, want ErrLogFull", txID, err)
		}
	}
	if err := g.Close(); err != nil {
		t.Fatal(err)
	}
	dev.Crash()
	got := recoveredSet(t, dev, capacity)
	assertSets(t, map[uint64]string{1: string(bytes.Repeat([]byte("x"), 50))}, got)
}

func TestReopenContinuesDurablePrefix(t *testing.T) {
	const capacity = 1 << 20
	dev := newFaultDevice(capacity)
	first, err := OpenGroupCommitter(dev, capacity)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Commit(context.Background(), 1, []byte("before")); err != nil {
		t.Fatal(err)
	}
	durable := first.DurableLSN()
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second, err := OpenGroupCommitter(dev, capacity)
	if err != nil {
		t.Fatal(err)
	}
	if got := second.DurableLSN(); got != durable {
		t.Fatalf("reopened durable LSN = %d, want %d", got, durable)
	}
	if _, err := second.Commit(context.Background(), 2, []byte("after")); err != nil {
		t.Fatal(err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	dev.Crash()
	got := recoveredSet(t, dev, capacity)
	assertSets(t, map[uint64]string{1: "before", 2: "after"}, got)
}

func waitUntil(t *testing.T, what string, cond func() bool) {
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

func assertSets(t *testing.T, want, got map[uint64]string) {
	t.Helper()
	if len(want) != len(got) {
		t.Fatalf("acknowledged/visible set size mismatch: acked=%d visible=%d\nacked=%v\nvisible=%v", len(want), len(got), want, got)
	}
	for id, payload := range want {
		gotPayload, ok := got[id]
		if !ok {
			t.Fatalf("transaction %d acknowledged but not visible", id)
		}
		if gotPayload != payload {
			t.Fatalf("transaction %d payload mismatch", id)
		}
	}
	for id := range got {
		if _, ok := want[id]; !ok {
			t.Fatalf("transaction %d visible but never acknowledged", id)
		}
	}
}
