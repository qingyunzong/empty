package formal

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func openTestCoordinator(t *testing.T, dir string, options ...Option) *Coordinator {
	t.Helper()
	c, err := Open(dir, options...)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		if err := c.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return c
}

func beginTestTxn(t *testing.T, c *Coordinator, id TxnID, records ...Record) *Transaction {
	t.Helper()
	tx, err := c.Begin(context.Background(), id)
	if err != nil {
		t.Fatalf("Begin(%q): %v", id, err)
	}
	if len(records) > 0 {
		if err := tx.Append(records...); err != nil {
			t.Fatalf("Append(%q): %v", id, err)
		}
	}
	return tx
}

func preparedTestTxn(t *testing.T, c *Coordinator, id TxnID, records ...Record) (*Transaction, Receipt) {
	t.Helper()
	tx := beginTestTxn(t, c, id, records...)
	receipt, err := tx.Prepare(context.Background())
	if err != nil {
		t.Fatalf("Prepare(%q): %v", id, err)
	}
	return tx, receipt
}

func committedTestTxn(t *testing.T, c *Coordinator, id TxnID, records ...Record) (*Transaction, Receipt) {
	t.Helper()
	tx, _ := preparedTestTxn(t, c, id, records...)
	receipt, err := tx.Commit(context.Background())
	if err != nil {
		t.Fatalf("Commit(%q): %v", id, err)
	}
	return tx, receipt
}

func recordIDs(records []OutputRecord) []string {
	ids := make([]string, len(records))
	for i, record := range records {
		ids[i] = record.Record.ID
	}
	return ids
}

func assertIDs(t *testing.T, got []string, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("record count = %d (%v), want %d (%v)", len(got), got, len(want), want)
	}
	seen := make(map[string]int, len(got))
	for _, id := range got {
		seen[id]++
	}
	for _, id := range want {
		if seen[id] != 1 {
			t.Fatalf("record %q appears %d times in %v", id, seen[id], got)
		}
	}
}

func TestPreparedDataIsNotVisibleUntilCommit(t *testing.T) {
	sink := NewMemorySink()
	c := openTestCoordinator(t, t.TempDir(), WithSink(sink))

	tx := beginTestTxn(t, c, "txn-1",
		Record{ID: "r1", Data: []byte("one")},
		Record{ID: "r2", Data: []byte("two")},
	)
	prepared, err := tx.Prepare(context.Background())
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if prepared.State != TxnPrepared || prepared.CommitSeq != 0 {
		t.Fatalf("prepared receipt = %+v", prepared)
	}
	if got := c.CommittedRecords(); len(got) != 0 {
		t.Fatalf("prepared records leaked into committed view: %+v", got)
	}
	if got := sink.Records(); len(got) != 0 {
		t.Fatalf("prepared records reached sink: %+v", got)
	}
	inflight := c.InFlight()
	if len(inflight) != 1 || inflight[0].State != TxnPrepared || len(inflight[0].Records) != 2 {
		t.Fatalf("in-flight view = %+v", inflight)
	}

	committed, err := tx.Commit(context.Background())
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if committed.State != TxnCommitted || committed.CommitSeq == 0 {
		t.Fatalf("committed receipt = %+v", committed)
	}
	if len(c.InFlight()) != 0 {
		t.Fatalf("committed transaction still in flight: %+v", c.InFlight())
	}
	assertIDs(t, recordIDs(c.CommittedRecords()), "r1", "r2")
	assertIDs(t, recordIDs(sink.Records()), "r1", "r2")

	// A duplicate Begin+Commit must return the same receipt and must not
	// deliver the records a second time.
	tx2 := beginTestTxn(t, c, "txn-1")
	retry, err := tx2.Commit(context.Background())
	if err != nil {
		t.Fatalf("duplicate Commit: %v", err)
	}
	if retry != committed {
		t.Fatalf("duplicate receipt = %+v, want %+v", retry, committed)
	}
	if sink.Len() != 1 {
		t.Fatalf("sink deliveries = %d, want 1", sink.Len())
	}
	assertIDs(t, recordIDs(sink.Records()), "r1", "r2")
}

func TestOpenPreparedAndCommittedSetsAreSeparated(t *testing.T) {
	c := openTestCoordinator(t, t.TempDir())
	_, committed := committedTestTxn(t, c, "committed", Record{ID: "c1"})
	preparedTestTxn(t, c, "prepared", Record{ID: "p1"})
	beginTestTxn(t, c, "open", Record{ID: "o1"})

	committedView := c.Committed()
	if len(committedView) != 1 || committedView[0].TxnID != "committed" || committedView[0].CommitSeq != committed.CommitSeq {
		t.Fatalf("committed view = %+v", committedView)
	}
	inflight := c.InFlight()
	if len(inflight) != 2 {
		t.Fatalf("in-flight count = %d, want 2: %+v", len(inflight), inflight)
	}
	states := map[TxnID]TxnState{}
	for _, view := range inflight {
		states[view.TxnID] = view.State
	}
	if states["prepared"] != TxnPrepared || states["open"] != TxnOpen {
		t.Fatalf("in-flight states = %v", states)
	}
	assertIDs(t, recordIDs(c.CommittedRecords()), "c1")
}

func TestAbortIsIdempotentAndNeverVisible(t *testing.T) {
	sink := NewMemorySink()
	c := openTestCoordinator(t, t.TempDir(), WithSink(sink))
	tx, _ := preparedTestTxn(t, c, "abort-me", Record{ID: "gone"})

	receipt, err := tx.Abort(context.Background())
	if err != nil {
		t.Fatalf("Abort: %v", err)
	}
	if receipt.State != TxnAborted || receipt.AbortSeq == 0 {
		t.Fatalf("abort receipt = %+v", receipt)
	}
	again, err := tx.Abort(context.Background())
	if err != nil {
		t.Fatalf("duplicate Abort: %v", err)
	}
	if again != receipt {
		t.Fatalf("duplicate abort receipt = %+v, want %+v", again, receipt)
	}
	if _, err := tx.Commit(context.Background()); !errors.Is(err, ErrAborted) {
		t.Fatalf("Commit after abort error = %v, want ErrAborted", err)
	}
	if len(c.CommittedRecords()) != 0 || sink.Len() != 0 {
		t.Fatal("aborted record became visible")
	}
}

func TestAbortOpenReceiptIsStableAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	c := openTestCoordinator(t, dir)
	tx := beginTestTxn(t, c, "open-abort", Record{ID: "not-durable"})
	receipt, err := tx.Abort(context.Background())
	if err != nil {
		t.Fatalf("Abort: %v", err)
	}
	if receipt.State != TxnAborted || receipt.RecordCount != 0 || receipt.Digest != ([32]byte{}) {
		t.Fatalf("open abort receipt = %+v", receipt)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	c2 := openTestCoordinator(t, dir)
	replayed, ok := c2.Result("open-abort")
	if !ok || replayed != receipt {
		t.Fatalf("replayed receipt = %+v, %v; want %+v", replayed, ok, receipt)
	}
}

func TestRecordIDCanOnlyCommitInOneTransaction(t *testing.T) {
	c := openTestCoordinator(t, t.TempDir())
	committedTestTxn(t, c, "first", Record{ID: "shared", Data: []byte("a")})
	tx, _ := preparedTestTxn(t, c, "second", Record{ID: "shared", Data: []byte("a")})
	if _, err := tx.Commit(context.Background()); !errors.Is(err, ErrRecordConflict) {
		t.Fatalf("conflicting Commit error = %v, want ErrRecordConflict", err)
	}
	if state, _ := c.State("second"); state != TxnPrepared {
		t.Fatalf("second transaction state = %s, want prepared", state)
	}
	assertIDs(t, recordIDs(c.CommittedRecords()), "shared")
}

func TestJournalReplaysReceiptsAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	sink := NewMemorySink()
	c := openTestCoordinator(t, dir, WithSink(sink))
	_, receipt := committedTestTxn(t, c, "restart",
		Record{ID: "a", Data: []byte("A")},
		Record{ID: "b", Data: []byte("B")},
	)
	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	c2 := openTestCoordinator(t, dir, WithSink(sink))
	replayed, ok := c2.Result("restart")
	if !ok || replayed != receipt {
		t.Fatalf("replayed receipt = %+v, %v; want %+v", replayed, ok, receipt)
	}
	assertIDs(t, recordIDs(c2.CommittedRecords()), "a", "b")
	if sink.Len() != 1 {
		t.Fatalf("sink deliveries = %d, want 1", sink.Len())
	}
}

func TestTornJournalTailIsDiscarded(t *testing.T) {
	dir := t.TempDir()
	c := openTestCoordinator(t, dir)
	_, receipt := committedTestTxn(t, c, "kept", Record{ID: "ok"})
	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	path := filepath.Join(dir, "commit.log")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("open journal: %v", err)
	}
	// A killed process can leave a partial frame header. It never represents a
	// complete commit and must be ignored rather than exposed.
	if _, err := f.Write([]byte{0x46, 0x43, 0x50, 0x47, 0x00, 0x01, 0x02}); err != nil {
		t.Fatalf("append torn frame: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close journal: %v", err)
	}

	c2 := openTestCoordinator(t, dir)
	got, ok := c2.Result("kept")
	if !ok || got != receipt {
		t.Fatalf("receipt after torn tail = %+v, %v; want %+v", got, ok, receipt)
	}
	assertIDs(t, recordIDs(c2.CommittedRecords()), "ok")
}

func TestConcurrentCommitsAreDeliveredInCommitOrder(t *testing.T) {
	sink := NewMemorySink()
	c := openTestCoordinator(t, t.TempDir(), WithSink(sink))

	const count = 12
	var txs []*Transaction
	for i := 0; i < count; i++ {
		id := TxnID("txn-" + string(rune('a'+i)))
		txs = append(txs, beginTestTxn(t, c, id, Record{ID: "r-" + string(id)}))
	}
	for _, tx := range txs {
		if _, err := tx.Prepare(context.Background()); err != nil {
			t.Fatalf("Prepare(%q): %v", tx.ID(), err)
		}
	}

	var wg sync.WaitGroup
	errs := make(chan error, count)
	for _, tx := range txs {
		wg.Add(1)
		go func(tx *Transaction) {
			defer wg.Done()
			_, err := tx.Commit(context.Background())
			errs <- err
		}(tx)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("Commit: %v", err)
		}
	}

	deliveries := sink.Deliveries()
	if len(deliveries) != count {
		t.Fatalf("deliveries = %d, want %d", len(deliveries), count)
	}
	for i := 1; i < len(deliveries); i++ {
		if deliveries[i].CommitSeq <= deliveries[i-1].CommitSeq {
			t.Fatalf("delivery order is not commit order: %+v", deliveries)
		}
	}
	if len(c.CommittedRecords()) != count {
		t.Fatalf("committed records = %d, want %d", len(c.CommittedRecords()), count)
	}
}

type flakySink struct {
	mu       sync.Mutex
	fail     bool
	attempts int
	inner    *MemorySink
}

var errSinkDown = errors.New("sink down")

func (s *flakySink) Apply(ctx context.Context, delivery Delivery) error {
	s.mu.Lock()
	s.attempts++
	fail := s.fail
	s.mu.Unlock()
	if fail {
		return errSinkDown
	}
	return s.inner.Apply(ctx, delivery)
}

func (s *flakySink) setFail(fail bool) {
	s.mu.Lock()
	s.fail = fail
	s.mu.Unlock()
}

func (s *flakySink) attemptCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.attempts
}

type firstFailureSink struct {
	mu       sync.Mutex
	attempts int
	inner    *MemorySink
}

func (s *firstFailureSink) Apply(ctx context.Context, delivery Delivery) error {
	s.mu.Lock()
	s.attempts++
	attempt := s.attempts
	s.mu.Unlock()
	if attempt == 1 {
		return errSinkDown
	}
	return s.inner.Apply(ctx, delivery)
}

func TestFailedEarlierDeliveryBlocksLaterCommit(t *testing.T) {
	sink := &firstFailureSink{inner: NewMemorySink()}
	c := openTestCoordinator(t, t.TempDir(), WithSink(sink))

	txA, _ := preparedTestTxn(t, c, "a", Record{ID: "a1"})
	txB, _ := preparedTestTxn(t, c, "b", Record{ID: "b1"})

	if _, err := txA.Commit(context.Background()); !errors.Is(err, errSinkDown) {
		t.Fatalf("Commit(a) error = %v, want sink failure", err)
	}
	if _, err := txB.Commit(context.Background()); err != nil {
		t.Fatalf("Commit(b) after a recovered: %v", err)
	}

	deliveries := sink.inner.Deliveries()
	if len(deliveries) != 2 {
		t.Fatalf("deliveries = %d, want 2", len(deliveries))
	}
	if deliveries[0].TxnID != "a" || deliveries[1].TxnID != "b" {
		t.Fatalf("delivery order = %q, %q; want a, b", deliveries[0].TxnID, deliveries[1].TxnID)
	}
	if len(c.PendingAcks()) != 0 {
		t.Fatalf("pending acknowledgements = %d, want 0", len(c.PendingAcks()))
	}
}

func TestSinkFailureKeepsDecisionAndRetriesDelivery(t *testing.T) {
	dir := t.TempDir()
	sink := &flakySink{inner: NewMemorySink(), fail: true}
	c := openTestCoordinator(t, dir, WithSink(sink))
	tx, _ := preparedTestTxn(t, c, "durable", Record{ID: "out"})

	receipt, err := tx.Commit(context.Background())
	if !errors.Is(err, errSinkDown) {
		t.Fatalf("Commit error = %v, want sink failure", err)
	}
	if !receipt.Committed() {
		t.Fatalf("commit decision was lost: %+v", receipt)
	}
	if state, _ := c.State("durable"); state != TxnCommitted {
		t.Fatalf("state = %s, want committed", state)
	}
	if len(c.PendingAcks()) != 1 || len(c.CommittedRecords()) != 1 {
		t.Fatalf("pending=%d committed=%d", len(c.PendingAcks()), len(c.CommittedRecords()))
	}
	if sink.inner.Len() != 0 {
		t.Fatal("failed sink recorded a delivery")
	}

	// Fail again on a retry, then recover the sink. The commit log is already
	// authoritative, so no new commit record may be appended.
	if _, err := tx.Commit(context.Background()); !errors.Is(err, errSinkDown) {
		t.Fatalf("retry error = %v, want sink failure", err)
	}
	sink.setFail(false)
	retried, err := tx.Commit(context.Background())
	if err != nil {
		t.Fatalf("Commit after sink recovery: %v", err)
	}
	if retried != receipt {
		t.Fatalf("retry receipt = %+v, want %+v", retried, receipt)
	}
	if sink.inner.Len() != 1 || len(c.PendingAcks()) != 0 {
		t.Fatalf("sink deliveries=%d pending=%d", sink.inner.Len(), len(c.PendingAcks()))
	}

	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	c2 := openTestCoordinator(t, dir, WithSink(sink))
	replayed, _ := c2.Result("durable")
	if replayed != receipt {
		t.Fatalf("replayed receipt = %+v, want %+v", replayed, receipt)
	}
	if sink.inner.Len() != 1 || sink.attemptCount() != 3 {
		t.Fatalf("sink deliveries=%d attempts=%d, want 1/3", sink.inner.Len(), sink.attemptCount())
	}
}
