package formal

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
)

// CommitRecord is one transaction's commit record. Payload is opaque to the
// group committer. TransactionID is only metadata, but callers should keep it
// unique so a recovered log can be matched to transactions.
type CommitRecord struct {
	TransactionID uint64
	Payload       []byte
}

// CommitResult describes a record that is covered by the durable LSN when the
// call returns nil.
type CommitResult struct {
	TransactionID   uint64
	StartLSN        LSN
	EndLSN          LSN
	GroupGeneration uint64
	GroupRecords    int
}

type commitWaiter struct {
	txID    uint64
	payload []byte
	size    int

	done    chan struct{}
	claimed bool
	err     error
	result  CommitResult
}

// GroupCommitter serializes log writes and fsyncs. A batch of records is
// written with one sequence of WriteAt calls followed by one Sync; every
// waiter in that batch is acknowledged only after Sync succeeds.
type GroupCommitter struct {
	dev       BlockDevice
	capacity  int64
	maxGroup  int64
	mu        sync.Mutex
	cond      *sync.Cond
	pending   []*commitWaiter
	writeOff  int64
	nextGen   uint64
	durable   atomic.Uint64
	closed    bool
	closeErr  error
	writerEnd chan struct{}
}

// OpenGroupCommitter recovers the durable prefix of an existing log and starts
// the group writer. capacity is the byte size of the device. If capacity is
// non-positive and dev implements SizeProvider, its size is used.
func OpenGroupCommitter(dev BlockDevice, capacity int64) (*GroupCommitter, error) {
	if dev == nil {
		return nil, errors.New("formal: nil block device")
	}
	if capacity <= 0 {
		if sizer, ok := dev.(SizeProvider); ok {
			size, err := sizer.Size()
			if err != nil {
				return nil, fmt.Errorf("formal: determine device size: %w", err)
			}
			capacity = size
		}
	}
	if capacity <= 0 {
		return nil, errors.New("formal: device capacity must be positive")
	}

	recovered, err := Recover(dev, capacity)
	if err != nil {
		return nil, err
	}

	g := &GroupCommitter{
		dev:       dev,
		capacity:  capacity,
		writeOff:  int64(recovered.DurableLSN),
		nextGen:   recovered.LastGeneration + 1,
		writerEnd: make(chan struct{}),
	}
	if g.nextGen == 0 {
		g.nextGen = 1
	}
	g.durable.Store(uint64(recovered.DurableLSN))
	g.cond = sync.NewCond(&g.mu)
	go g.run()
	return g, nil
}

// NewGroupCommitter is an alias for OpenGroupCommitter. Opening an empty
// device starts a new log; opening a non-empty device resumes its durable
// prefix.
func NewGroupCommitter(dev BlockDevice, capacity int64) (*GroupCommitter, error) {
	return OpenGroupCommitter(dev, capacity)
}

// SetMaxGroupBytes limits the encoded bytes in one shared write/fsync group.
// A non-positive value means no explicit limit beyond the device capacity.
// Call it before submitting commits.
func (g *GroupCommitter) SetMaxGroupBytes(n int64) {
	g.mu.Lock()
	g.maxGroup = n
	g.mu.Unlock()
}

// DurableLSN returns the end offset of the last successfully synced group.
// It never moves backwards and never includes a short write or failed Sync.
func (g *GroupCommitter) DurableLSN() LSN {
	return LSN(g.durable.Load())
}

// Submit appends a commit record and waits until that record is covered by a
// successful fsync.
//
// Cancellation is honored only while the record is still queued. Once the
// writer has claimed the record into a group, the commit is linearized: the
// call waits for the fsync result and reports success if the group became
// durable. This rule is what keeps the acknowledged set identical to the set
// visible after recovery.
func (g *GroupCommitter) Submit(ctx context.Context, rec CommitRecord) (CommitResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return CommitResult{}, err
	}
	if uint64(len(rec.Payload)) > uint64(g.capacity) {
		return CommitResult{}, ErrLogFull
	}

	payload := append([]byte(nil), rec.Payload...)
	w := &commitWaiter{
		txID:    rec.TransactionID,
		payload: payload,
		size:    recordHeaderSize + len(payload),
		done:    make(chan struct{}),
	}

	g.mu.Lock()
	if g.closed {
		g.mu.Unlock()
		return CommitResult{}, ErrClosed
	}
	if int64(w.size)+groupHeaderSize+groupFooterSize > g.capacity {
		g.mu.Unlock()
		return CommitResult{}, ErrLogFull
	}
	g.pending = append(g.pending, w)
	g.cond.Signal()
	g.mu.Unlock()

	select {
	case <-w.done:
		return w.result, w.err
	case <-ctx.Done():
		g.mu.Lock()
		removed := g.removePendingLocked(w)
		claimed := w.claimed
		g.mu.Unlock()
		if removed {
			return CommitResult{}, ctx.Err()
		}
		if !claimed {
			// The writer took the batch between our select and lock. Treat
			// the commit as linearized and wait for its actual outcome.
			<-w.done
			return w.result, w.err
		}
		<-w.done
		return w.result, w.err
	}
}

// Commit is a convenience wrapper around Submit.
func (g *GroupCommitter) Commit(ctx context.Context, txID uint64, payload []byte) (CommitResult, error) {
	return g.Submit(ctx, CommitRecord{TransactionID: txID, Payload: payload})
}

func (g *GroupCommitter) removePendingLocked(w *commitWaiter) bool {
	for i, p := range g.pending {
		if p == w {
			g.pending = append(g.pending[:i], g.pending[i+1:]...)
			return true
		}
	}
	return false
}

func (g *GroupCommitter) run() {
	defer close(g.writerEnd)
	for {
		batch, generation, start, stop := g.takeBatch()
		if stop {
			return
		}
		if len(batch) == 0 {
			continue
		}

		encoded, err := encodeGroup(generation, start, batch)
		if err == nil {
			err = writeFullAt(g.dev, encoded.data, int64(start))
		}
		if err == nil {
			err = g.dev.Sync()
		}

		if err != nil {
			g.failBatch(batch, err)
			continue
		}

		for i, w := range batch {
			w.result = CommitResult{
				TransactionID:   w.txID,
				StartLSN:        encoded.recordLSN[i],
				EndLSN:          recordEnd(encoded.recordLSN[i], w.payload),
				GroupGeneration: generation,
				GroupRecords:    len(batch),
			}
		}
		g.finishBatch(batch, encoded.end)
	}
}

func recordEnd(start LSN, payload []byte) LSN {
	return start + LSN(recordHeaderSize+len(payload))
}

func (g *GroupCommitter) takeBatch() (batch []*commitWaiter, generation uint64, start LSN, stop bool) {
	g.mu.Lock()
	defer g.mu.Unlock()

	for len(g.pending) == 0 && !g.closed {
		g.cond.Wait()
	}
	if len(g.pending) == 0 {
		return nil, 0, 0, true
	}

	start = LSN(g.writeOff)
	limit := g.capacity - g.writeOff
	total := int64(groupHeaderSize + groupFooterSize)
	selected := make([]*commitWaiter, 0, len(g.pending))
	consumed := 0

	for consumed < len(g.pending) {
		w := g.pending[consumed]
		next := total + int64(w.size)
		overDevice := next > limit
		overBatch := g.maxGroup > 0 && len(selected) > 0 && next > g.maxGroup
		if len(selected) > 0 && (overDevice || overBatch) {
			break
		}
		if overDevice {
			// This record cannot fit at the current durable offset. Fail it
			// individually rather than stalling every later waiter forever.
			g.failWaiterLocked(w, ErrLogFull)
			consumed++
			continue
		}
		total = next
		selected = append(selected, w)
		consumed++
	}
	g.pending = append([]*commitWaiter(nil), g.pending[consumed:]...)
	if len(selected) == 0 {
		if len(g.pending) > 0 {
			g.cond.Signal()
		}
		return nil, 0, 0, false
	}

	for _, w := range selected {
		w.claimed = true
	}
	generation = g.nextGen
	g.nextGen++
	if g.nextGen == 0 {
		g.nextGen = 1
	}
	return selected, generation, start, false
}

func (g *GroupCommitter) failWaiterLocked(w *commitWaiter, err error) {
	w.claimed = true
	w.err = err
	close(w.done)
}

func (g *GroupCommitter) failBatch(batch []*commitWaiter, err error) {
	g.mu.Lock()
	// The attempted bytes must not become the basis for a later append. The
	// next group starts again at the last synced boundary.
	g.writeOff = int64(g.durable.Load())
	for _, w := range batch {
		w.err = err
		close(w.done)
	}
	g.mu.Unlock()
}

func (g *GroupCommitter) finishBatch(batch []*commitWaiter, end LSN) {
	g.mu.Lock()
	g.durable.Store(uint64(end))
	g.writeOff = int64(end)
	for _, w := range batch {
		close(w.done)
	}
	g.mu.Unlock()
}

// Close stops accepting new records, drains already queued records, and waits
// for the writer to finish. It intentionally does not issue an extra Sync: a
// failed group must never be made durable by a later close-time flush.
func (g *GroupCommitter) Close() error {
	g.mu.Lock()
	if !g.closed {
		g.closed = true
		g.cond.Broadcast()
	}
	g.mu.Unlock()
	<-g.writerEnd
	return g.closeErr
}

// Shutdown is Close with a cancellation boundary for callers that need one.
func (g *GroupCommitter) Shutdown(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		_ = g.Close()
		close(done)
	}()
	select {
	case <-done:
		return g.closeErr
	case <-ctx.Done():
		return ctx.Err()
	}
}
