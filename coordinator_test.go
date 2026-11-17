package formal

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type testClock struct {
	t time.Time
}

func newTestClock() *testClock {
	return &testClock{t: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
}

func (c *testClock) Now() time.Time {
	return c.t
}

func (c *testClock) Advance(d time.Duration) {
	c.t = c.t.Add(d)
}

func testMessage(id string) Message {
	return Message{
		ID:      id,
		Topic:   "orders",
		Body:    []byte("body-" + id),
		Headers: map[string]string{"message-id": id},
	}
}

func openTest(t *testing.T, store Store, opts ...Option) *Coordinator {
	t.Helper()
	base := []Option{
		WithDefaultTimeout(time.Minute),
		WithRecheckInterval(10 * time.Second),
	}
	c, err := Open(store, append(base, opts...)...)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return c
}

func reopenTest(t *testing.T, store Store, opts ...Option) *Coordinator {
	t.Helper()
	data, err := store.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	fresh := NewMemoryStore()
	if err := fresh.Append(data); err != nil {
		t.Fatalf("seed store: %v", err)
	}
	return openTest(t, fresh, opts...)
}

func requireDelivered(t *testing.T, c *Coordinator, ids ...string) {
	t.Helper()
	got := c.Deliverable()
	if len(got) != len(ids) {
		t.Fatalf("deliverable count = %d, want %d (%v)", len(got), len(ids), got)
	}
	seen := make(map[string]int)
	for _, d := range got {
		seen[d.Message.ID]++
	}
	for _, id := range ids {
		if seen[id] != 1 {
			t.Fatalf("message %q delivered %d times, want exactly once; set=%v", id, seen[id], seen)
		}
	}
}

func TestLifecycleAndFinalIdempotency(t *testing.T) {
	clk := newTestClock()
	store := NewMemoryStore()
	c := openTest(t, store, WithClock(clk.Now))

	req := PrepareRequest{ID: "tx-1", Message: testMessage("m-1"), Timeout: time.Minute}
	receipt, err := c.Prepare(req)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if receipt.Duplicate {
		t.Fatal("first prepare marked duplicate")
	}
	if receipt.Ref.Gen != 1 {
		t.Fatalf("generation = %d, want 1", receipt.Ref.Gen)
	}
	if got := c.Deliverable(); len(got) != 0 {
		t.Fatalf("prepared message is visible: %v", got)
	}
	if a, ok := c.Lookup("tx-1"); !ok || a.State != StatePrepared {
		t.Fatalf("lookup after prepare = %+v, %v", a, ok)
	}
	if stats := c.Stats(); stats.Records != 1 || stats.Delivered != 0 || stats.Prepared != 1 {
		t.Fatalf("stats after prepare = %+v", stats)
	}

	decision, err := c.Commit(receipt.Ref)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if decision.State != StateCommitted || decision.Duplicate || decision.Conflict {
		t.Fatalf("first commit decision = %+v", decision)
	}
	requireDelivered(t, c, "m-1")

	again, err := c.Commit(receipt.Ref)
	if err != nil {
		t.Fatalf("duplicate Commit: %v", err)
	}
	if again.State != StateCommitted || !again.Duplicate || again.Conflict {
		t.Fatalf("duplicate commit decision = %+v", again)
	}
	if !again.DecidedAt.Equal(decision.DecidedAt) {
		t.Fatalf("duplicate decision time changed: %v != %v", again.DecidedAt, decision.DecidedAt)
	}
	requireDelivered(t, c, "m-1")
	if stats := c.Stats(); stats.Records != 2 || stats.Delivered != 1 {
		t.Fatalf("duplicate commit appended state: %+v", stats)
	}

	conflict, err := c.Rollback(receipt.Ref, "late rollback")
	if err != nil {
		t.Fatalf("conflicting Rollback: %v", err)
	}
	if conflict.State != StateCommitted || !conflict.Duplicate || !conflict.Conflict {
		t.Fatalf("conflicting decision = %+v", conflict)
	}
	requireDelivered(t, c, "m-1")
	if stats := c.Stats(); stats.Records != 2 {
		t.Fatalf("conflicting decision appended state: %+v", stats)
	}

	replayed := reopenTest(t, store, WithClock(clk.Now))
	requireDelivered(t, replayed, "m-1")
	a, ok := replayed.Get(receipt.Ref)
	if !ok || a.State != StateCommitted || !a.DecidedAt.Equal(decision.DecidedAt) {
		t.Fatalf("replayed decision = %+v, %v", a, ok)
	}
}

func TestPrepareRetryIsIdempotentWhilePrepared(t *testing.T) {
	clk := newTestClock()
	store := NewMemoryStore()
	c := openTest(t, store, WithClock(clk.Now))

	req := PrepareRequest{ID: "tx-1", Message: testMessage("m-1")}
	first, err := c.Prepare(req)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	second, err := c.Prepare(req)
	if err != nil {
		t.Fatalf("retry Prepare: %v", err)
	}
	if second.Ref != first.Ref || !second.Duplicate {
		t.Fatalf("retry receipt = %+v, first = %+v", second, first)
	}
	if stats := c.Stats(); stats.Records != 1 || stats.Attempts != 1 {
		t.Fatalf("retry appended a second prepare: %+v", stats)
	}

	other := req
	other.Message = testMessage("m-2")
	if _, err := c.Prepare(other); !errors.Is(err, ErrInFlight) {
		t.Fatalf("different message on unresolved ID error = %v, want ErrInFlight", err)
	}

	if _, err := c.Commit(first.Ref); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	next, err := c.Prepare(req)
	if err != nil {
		t.Fatalf("Prepare after final: %v", err)
	}
	if next.Ref.ID != first.Ref.ID || next.Ref.Gen <= first.Ref.Gen {
		t.Fatalf("reused ID did not advance generation: first=%s next=%s", first.Ref, next.Ref)
	}
	requireDelivered(t, c, "m-1")
}

func TestGenerationIsolation(t *testing.T) {
	clk := newTestClock()
	store := NewMemoryStore()
	c := openTest(t, store, WithClock(clk.Now))

	g1, err := c.Prepare(PrepareRequest{ID: "reused", Message: testMessage("m-1")})
	if err != nil {
		t.Fatalf("prepare g1: %v", err)
	}
	if _, err := c.Commit(g1.Ref); err != nil {
		t.Fatalf("commit g1: %v", err)
	}

	g2, err := c.Prepare(PrepareRequest{ID: "reused", Message: testMessage("m-2")})
	if err != nil {
		t.Fatalf("prepare g2: %v", err)
	}
	if g2.Ref.Gen <= g1.Ref.Gen {
		t.Fatalf("generation did not advance: %s -> %s", g1.Ref, g2.Ref)
	}

	// A late confirmation of the old generation must return the old decision
	// and must not touch the new generation.
	old, err := c.Commit(g1.Ref)
	if err != nil {
		t.Fatalf("old commit: %v", err)
	}
	if old.State != StateCommitted || !old.Duplicate {
		t.Fatalf("old decision = %+v", old)
	}
	if a, _ := c.Get(g2.Ref); a.State != StatePrepared {
		t.Fatalf("old confirmation changed new generation to %s", a.State)
	}
	requireDelivered(t, c, "m-1")

	if _, err := c.Rollback(g2.Ref, "not needed"); err != nil {
		t.Fatalf("rollback g2: %v", err)
	}
	requireDelivered(t, c, "m-1")

	g3, err := c.Prepare(PrepareRequest{ID: "reused", Message: testMessage("m-3")})
	if err != nil {
		t.Fatalf("prepare g3: %v", err)
	}
	if _, err := c.Commit(g3.Ref); err != nil {
		t.Fatalf("commit g3: %v", err)
	}
	again, err := c.Rollback(g2.Ref, "ignored")
	if err != nil {
		t.Fatalf("duplicate rollback: %v", err)
	}
	if again.State != StateRolledBack || !again.Duplicate || again.Conflict {
		t.Fatalf("duplicate rollback decision = %+v", again)
	}
	conflict, err := c.Commit(g2.Ref)
	if err != nil {
		t.Fatalf("conflicting commit: %v", err)
	}
	if conflict.State != StateRolledBack || !conflict.Duplicate || !conflict.Conflict {
		t.Fatalf("conflicting commit decision = %+v", conflict)
	}
	if a, _ := c.Get(g3.Ref); a.State != StateCommitted {
		t.Fatalf("duplicate old decision changed current generation to %s", a.State)
	}

	replayed := reopenTest(t, store, WithClock(clk.Now))
	requireDelivered(t, replayed, "m-1", "m-3")
	for _, ref := range []Ref{g1.Ref, g2.Ref, g3.Ref} {
		if _, ok := replayed.Get(ref); !ok {
			t.Fatalf("replay lost %s", ref)
		}
	}
	if a, _ := replayed.Get(g2.Ref); a.State != StateRolledBack {
		t.Fatalf("replayed g2 = %s, want rolled_back", a.State)
	}

	// Unknown future generations are rejected, not applied to the current one.
	if _, err := replayed.Commit(Ref{ID: "reused", Gen: 99}); !errors.Is(err, ErrUnknownTransaction) {
		t.Fatalf("future generation error = %v, want ErrUnknownTransaction", err)
	}

	// Simulate a pruned history to exercise the stale-generation guard.
	delete(replayed.attempts, g1.Ref)
	_, err = replayed.Commit(g1.Ref)
	var stale *StaleConfirmationError
	if !errors.As(err, &stale) || !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale confirmation error = %v", err)
	}
	if stale.Current != g3.Ref {
		t.Fatalf("stale current = %s, want %s", stale.Current, g3.Ref)
	}
	if a, _ := replayed.Get(g3.Ref); a.State != StateCommitted {
		t.Fatalf("stale confirmation changed current generation to %s", a.State)
	}
}

func TestTimeoutAndRequery(t *testing.T) {
	clk := newTestClock()
	store := NewMemoryStore()
	c := openTest(t, store,
		WithClock(clk.Now),
		WithRecheckInterval(10*time.Second),
		WithMaxChecks(2),
	)

	receipt, err := c.Prepare(PrepareRequest{
		ID:      "timeout-1",
		Message: testMessage("m-timeout"),
		Timeout: 30 * time.Second,
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if got := c.Due(); len(got) != 0 {
		t.Fatalf("transaction due before deadline: %v", got)
	}
	clk.Advance(29 * time.Second)
	if got := c.Due(); len(got) != 0 {
		t.Fatalf("transaction due one second early: %v", got)
	}
	clk.Advance(time.Second)
	due := c.Due()
	if len(due) != 1 || due[0].Ref != receipt.Ref || due[0].Checks != 0 || due[0].Exhausted {
		t.Fatalf("first due = %+v", due)
	}

	checked, err := c.MarkChecked(receipt.Ref)
	if err != nil {
		t.Fatalf("MarkChecked: %v", err)
	}
	if checked.Checks != 1 || checked.Exhausted {
		t.Fatalf("first check = %+v", checked)
	}
	if got := c.Due(); len(got) != 0 {
		t.Fatalf("transaction immediately due again: %v", got)
	}

	clk.Advance(10 * time.Second)
	due = c.Due()
	if len(due) != 1 || due[0].Checks != 1 {
		t.Fatalf("second due = %+v", due)
	}
	checked, err = c.MarkChecked(receipt.Ref)
	if err != nil {
		t.Fatalf("second MarkChecked: %v", err)
	}
	if checked.Checks != 2 || !checked.Exhausted {
		t.Fatalf("exhausted check = %+v", checked)
	}

	replayed := reopenTest(t, store, WithClock(clk.Now), WithRecheckInterval(10*time.Second), WithMaxChecks(2))
	a, ok := replayed.Get(receipt.Ref)
	if !ok || a.Checks != 2 || a.State != StatePrepared {
		t.Fatalf("replayed check state = %+v, %v", a, ok)
	}
	clk.Advance(10 * time.Second)
	if got := replayed.Due(); len(got) != 1 || !got[0].Exhausted {
		t.Fatalf("replayed due = %+v", got)
	}

	if _, err := replayed.Rollback(receipt.Ref, "business gave up"); err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if got := replayed.Due(); len(got) != 0 {
		t.Fatalf("decided transaction still due: %v", got)
	}
	if got := replayed.Deliverable(); len(got) != 0 {
		t.Fatalf("rolled-back message visible: %v", got)
	}
	a, _ = replayed.Get(receipt.Ref)
	if a.State != StateRolledBack || a.Reason != "business gave up" {
		t.Fatalf("rollback state = %+v", a)
	}
	if _, err := replayed.MarkChecked(receipt.Ref); !errors.Is(err, ErrAlreadyDecided) {
		t.Fatalf("MarkChecked after decision error = %v, want ErrAlreadyDecided", err)
	}
}

func TestPrepareValidationAndAutoID(t *testing.T) {
	clk := newTestClock()
	c := openTest(t, NewMemoryStore(), WithClock(clk.Now), WithDefaultTimeout(45*time.Second))

	if _, err := c.Prepare(PrepareRequest{ID: "x"}); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("empty message error = %v", err)
	}
	if _, err := c.Prepare(PrepareRequest{
		ID:      "x",
		Message: testMessage("m"),
		Timeout: -time.Second,
	}); !errors.Is(err, ErrInvalidTimeout) {
		t.Fatalf("negative timeout error = %v", err)
	}

	r1, err := c.Prepare(PrepareRequest{Message: testMessage("auto-1")})
	if err != nil {
		t.Fatalf("auto Prepare: %v", err)
	}
	if r1.Ref.ID == "" || !r1.ExpiresAt.Equal(clk.Now().Add(45*time.Second)) {
		t.Fatalf("auto receipt = %+v", r1)
	}
	r2, err := c.Prepare(PrepareRequest{Message: testMessage("auto-2")})
	if err != nil {
		t.Fatalf("second auto Prepare: %v", err)
	}
	if r1.Ref.ID == r2.Ref.ID {
		t.Fatalf("auto IDs collided: %s", r1.Ref.ID)
	}
	if _, ok := c.Lookup("missing"); ok {
		t.Fatal("Lookup reported a missing transaction")
	}
}

func TestPendingSnapshot(t *testing.T) {
	clk := newTestClock()
	c := openTest(t, NewMemoryStore(), WithClock(clk.Now))
	late := mustPrepare(t, c, "pending-late", "m-late", 20*time.Second)
	early := mustPrepare(t, c, "pending-early", "m-early", 10*time.Second)

	pending := c.Pending()
	if len(pending) != 2 {
		t.Fatalf("Pending = %+v", pending)
	}
	if pending[0].Ref != early.Ref || pending[1].Ref != late.Ref {
		t.Fatalf("Pending order = [%s, %s], want [%s, %s]",
			pending[0].Ref, pending[1].Ref, early.Ref, late.Ref)
	}
	if _, err := c.Commit(early.Ref); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	pending = c.Pending()
	if len(pending) != 1 || pending[0].Ref != late.Ref {
		t.Fatalf("Pending after commit = %+v", pending)
	}
}

func TestAutoIDDoesNotCollideWithCallerID(t *testing.T) {
	clk := newTestClock()
	store := NewMemoryStore()
	c := openTest(t, store, WithClock(clk.Now))
	explicit := mustPrepare(t, c, "txn-2", "m-explicit", time.Minute)
	auto, err := c.Prepare(PrepareRequest{Message: testMessage("m-auto")})
	if err != nil {
		t.Fatalf("auto Prepare: %v", err)
	}
	if auto.Ref.ID == explicit.Ref.ID {
		t.Fatalf("auto ID collided with caller ID %s", explicit.Ref.ID)
	}
	if auto.Ref.Gen <= explicit.Ref.Gen {
		t.Fatalf("auto generation = %d, want > %d", auto.Ref.Gen, explicit.Ref.Gen)
	}
	if _, err := c.Commit(explicit.Ref); err != nil {
		t.Fatalf("commit explicit: %v", err)
	}
	if _, err := c.Commit(auto.Ref); err != nil {
		t.Fatalf("commit auto: %v", err)
	}
	requireDelivered(t, c, "m-explicit", "m-auto")

	replayed := reopenTest(t, store, WithClock(clk.Now))
	requireDelivered(t, replayed, "m-explicit", "m-auto")
	if stats := replayed.Stats(); stats.NextGeneration != auto.Ref.Gen {
		t.Fatalf("replayed next generation = %d, want %d", stats.NextGeneration, auto.Ref.Gen)
	}
}

func TestOpenOptionValidation(t *testing.T) {
	tests := []struct {
		name  string
		store Store
		opt   Option
	}{
		{name: "nil store", store: nil},
		{name: "nil clock", store: NewMemoryStore(), opt: WithClock(nil)},
		{name: "zero timeout", store: NewMemoryStore(), opt: WithDefaultTimeout(0)},
		{name: "negative recheck", store: NewMemoryStore(), opt: WithRecheckInterval(-time.Second)},
		{name: "negative max checks", store: NewMemoryStore(), opt: WithMaxChecks(-1)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var opts []Option
			if tc.opt != nil {
				opts = append(opts, tc.opt)
			}
			if _, err := Open(tc.store, opts...); err == nil {
				t.Fatal("Open accepted invalid configuration")
			}
		})
	}
}

func TestConcurrentDuplicateConfirmations(t *testing.T) {
	clk := newTestClock()
	c := openTest(t, NewMemoryStore(), WithClock(clk.Now))
	receipt, err := c.Prepare(PrepareRequest{ID: "race-1", Message: testMessage("m-race")})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}

	const workers = 16
	results := make(chan Decision, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			d, err := c.Commit(receipt.Ref)
			if err != nil {
				t.Errorf("Commit: %v", err)
				return
			}
			results <- d
		}()
	}
	wg.Wait()
	close(results)

	fresh := 0
	for d := range results {
		if d.State != StateCommitted {
			t.Fatalf("decision = %+v", d)
		}
		if !d.Duplicate {
			fresh++
		}
	}
	if fresh != 1 {
		t.Fatalf("%d commits were treated as the first decision, want 1", fresh)
	}
	requireDelivered(t, c, "m-race")
	if stats := c.Stats(); stats.Records != 2 || stats.Delivered != 1 {
		t.Fatalf("concurrent commits appended duplicates: %+v", stats)
	}

	// Concurrent prepare retries must also converge on one durable record.
	retry, err := c.Prepare(PrepareRequest{ID: "race-2", Message: testMessage("m-retry")})
	if err != nil {
		t.Fatalf("Prepare race-2: %v", err)
	}
	refs := make(chan Ref, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := c.Prepare(PrepareRequest{ID: "race-2", Message: testMessage("m-retry")})
			if err != nil {
				t.Errorf("retry Prepare: %v", err)
				return
			}
			refs <- r.Ref
		}()
	}
	wg.Wait()
	close(refs)
	for ref := range refs {
		if ref != retry.Ref {
			t.Fatalf("retry produced %s, want %s", ref, retry.Ref)
		}
	}
}

func TestFileStoreSurvivesReopenAndTornTail(t *testing.T) {
	clk := newTestClock()
	path := filepath.Join(t.TempDir(), "transactions.log")
	fs, err := OpenFileStore(path)
	if err != nil {
		t.Fatalf("OpenFileStore: %v", err)
	}
	c := openTest(t, fs, WithClock(clk.Now))
	receipt, err := c.Prepare(PrepareRequest{ID: "file-1", Message: testMessage("m-file")})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if _, err := c.Commit(receipt.Ref); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if err := fs.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	fs, err = OpenFileStore(path)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	c = openTest(t, fs, WithClock(clk.Now))
	requireDelivered(t, c, "m-file")

	// Append a torn frame directly, then verify Open discards it and accepts
	// new records after truncating.
	frame, err := encodeFrame(record{
		Version:  recordVersion,
		Kind:     recordPrepare,
		Ref:      Ref{ID: "torn", Gen: 99},
		At:       jsonTime{clk.Now()},
		Message:  func() *Message { m := testMessage("m-torn"); return &m }(),
		Deadline: jsonTime{clk.Now().Add(time.Minute)},
	})
	if err != nil {
		t.Fatalf("encodeFrame: %v", err)
	}
	if err := fs.Append(frame[:len(frame)/2]); err != nil {
		t.Fatalf("append torn frame: %v", err)
	}
	if err := fs.Close(); err != nil {
		t.Fatalf("close after torn frame: %v", err)
	}

	fs, err = OpenFileStore(path)
	if err != nil {
		t.Fatalf("reopen torn store: %v", err)
	}
	defer fs.Close()
	c = openTest(t, fs, WithClock(clk.Now))
	if stats := c.Stats(); stats.TornTailBytes == 0 {
		t.Fatalf("torn tail was not reported: %+v", stats)
	}
	before, _ := fs.Read()
	parsed, err := parseJournal(before)
	if err != nil {
		t.Fatalf("parse after recovery: %v", err)
	}
	if parsed.tail != 0 || parsed.valid != len(before) {
		t.Fatalf("torn tail was not truncated: valid=%d len=%d tail=%d", parsed.valid, len(before), parsed.tail)
	}
	requireDelivered(t, c, "m-file")

	r2, err := c.Prepare(PrepareRequest{ID: "file-2", Message: testMessage("m-file-2")})
	if err != nil {
		t.Fatalf("Prepare after recovery: %v", err)
	}
	if _, err := c.Commit(r2.Ref); err != nil {
		t.Fatalf("Commit after recovery: %v", err)
	}
	requireDelivered(t, c, "m-file", "m-file-2")
}

type flakyStore struct {
	*MemoryStore
	failNext bool
	keep     int
}

func (s *flakyStore) Append(p []byte) error {
	if s.failNext {
		s.failNext = false
		keep := s.keep
		if keep > len(p) {
			keep = len(p)
		}
		if err := s.MemoryStore.Append(p[:keep]); err != nil {
			return err
		}
		return fmt.Errorf("injected append failure after %d bytes", keep)
	}
	return s.MemoryStore.Append(p)
}

func TestAppendFailurePoisonsUntilReopen(t *testing.T) {
	clk := newTestClock()
	store := &flakyStore{MemoryStore: NewMemoryStore()}
	c := openTest(t, store, WithClock(clk.Now))
	receipt, err := c.Prepare(PrepareRequest{ID: "flaky-1", Message: testMessage("m-flaky")})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}

	store.failNext = true
	store.keep = 7
	if _, err := c.Commit(receipt.Ref); err == nil {
		t.Fatal("Commit succeeded despite injected append failure")
	}
	if !c.Stats().Broken {
		t.Fatal("coordinator did not become broken after append failure")
	}
	if _, err := c.Prepare(PrepareRequest{ID: "flaky-2", Message: testMessage("m-other")}); err == nil {
		t.Fatal("broken coordinator accepted a new prepare")
	}
	if got := c.Deliverable(); len(got) != 0 {
		t.Fatalf("failed commit became visible: %v", got)
	}

	// The failed append may have left a partial frame. Reopening must discard
	// it, recover the prepared attempt, and permit exactly one commit.
	recovered := openTest(t, store, WithClock(clk.Now))
	if a, ok := recovered.Get(receipt.Ref); !ok || a.State != StatePrepared {
		t.Fatalf("recovered state = %+v, %v", a, ok)
	}
	if got := recovered.Deliverable(); len(got) != 0 {
		t.Fatalf("partial commit is visible: %v", got)
	}
	if _, err := recovered.Commit(receipt.Ref); err != nil {
		t.Fatalf("Commit after recovery: %v", err)
	}
	requireDelivered(t, recovered, "m-flaky")

	replayed := reopenTest(t, store, WithClock(clk.Now))
	requireDelivered(t, replayed, "m-flaky")
}

func TestAmbiguousFullAppendIsResolvedByReplay(t *testing.T) {
	t.Run("commit", func(t *testing.T) {
		clk := newTestClock()
		store := &flakyStore{MemoryStore: NewMemoryStore()}
		c := openTest(t, store, WithClock(clk.Now))
		receipt := mustPrepare(t, c, "ambiguous-commit", "m-ambiguous-commit", time.Minute)

		store.failNext = true
		store.keep = 1 << 30
		if _, err := c.Commit(receipt.Ref); err == nil {
			t.Fatal("Commit reported success despite injected error")
		}
		if got := c.Deliverable(); len(got) != 0 {
			t.Fatalf("failed commit was applied in memory: %v", got)
		}

		recovered := openTest(t, store, WithClock(clk.Now))
		requireDelivered(t, recovered, "m-ambiguous-commit")
		decision := mustCommit(t, recovered, receipt.Ref)
		if !decision.Duplicate || decision.State != StateCommitted {
			t.Fatalf("retry after ambiguous full append = %+v", decision)
		}
		requireDelivered(t, recovered, "m-ambiguous-commit")

		replayed := openTest(t, store, WithClock(clk.Now))
		requireDelivered(t, replayed, "m-ambiguous-commit")
	})

	t.Run("prepare", func(t *testing.T) {
		clk := newTestClock()
		store := &flakyStore{MemoryStore: NewMemoryStore()}
		c := openTest(t, store, WithClock(clk.Now))
		req := PrepareRequest{ID: "ambiguous-prepare", Message: testMessage("m-ambiguous-prepare")}

		store.failNext = true
		store.keep = 1 << 30
		if _, err := c.Prepare(req); err == nil {
			t.Fatal("Prepare reported success despite injected error")
		}
		if _, ok := c.Lookup(req.ID); ok {
			t.Fatal("failed prepare was applied in memory")
		}

		recovered := openTest(t, store, WithClock(clk.Now))
		first, ok := recovered.Lookup(req.ID)
		if !ok || first.State != StatePrepared {
			t.Fatalf("recovered prepare = %+v, %v", first, ok)
		}
		retry, err := recovered.Prepare(req)
		if err != nil {
			t.Fatalf("Prepare retry: %v", err)
		}
		if retry.Ref != first.Ref || !retry.Duplicate {
			t.Fatalf("retry receipt = %+v, recovered = %+v", retry, first.Ref)
		}
		if _, err := recovered.Commit(retry.Ref); err != nil {
			t.Fatalf("Commit: %v", err)
		}
		requireDelivered(t, recovered, "m-ambiguous-prepare")
	})
}

func TestCorruptCompleteFrameIsRejected(t *testing.T) {
	clk := newTestClock()
	store := NewMemoryStore()
	c := openTest(t, store, WithClock(clk.Now))
	receipt, err := c.Prepare(PrepareRequest{ID: "corrupt-1", Message: testMessage("m-corrupt")})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if _, err := c.Commit(receipt.Ref); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	data, _ := store.Read()
	parsed, err := parseJournal(data)
	if err != nil {
		t.Fatalf("parseJournal: %v", err)
	}
	first := parsed.bounds[0]
	data[first[1]-1] ^= 0xff

	corrupt := NewMemoryStore()
	_ = corrupt.Append(data)
	if _, err := Open(corrupt); !errors.Is(err, ErrCorruptLog) {
		t.Fatalf("Open corrupted log error = %v, want ErrCorruptLog", err)
	}
}

func TestReadOnlyOutputsDoNotAliasInternalState(t *testing.T) {
	clk := newTestClock()
	c := openTest(t, NewMemoryStore(), WithClock(clk.Now))
	msg := testMessage("m-alias")
	receipt, err := c.Prepare(PrepareRequest{ID: "alias-1", Message: msg})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	msg.Body[0] = 'X'
	msg.Headers["message-id"] = "changed"
	if a, _ := c.Get(receipt.Ref); string(a.Message.Body) != "body-m-alias" || a.Message.Headers["message-id"] != "m-alias" {
		t.Fatalf("prepare retained caller aliases: %+v", a.Message)
	}
	if _, err := c.Commit(receipt.Ref); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	deliveries := c.Deliverable()
	deliveries[0].Message.Body[0] = 'Y'
	deliveries[0].Message.Headers["message-id"] = "changed"
	if again := c.Deliverable(); string(again[0].Message.Body) != "body-m-alias" {
		t.Fatalf("Deliverable exposed internal storage: %+v", again[0].Message)
	}
	if a, _ := c.Get(receipt.Ref); string(a.Message.Body) != "body-m-alias" {
		t.Fatalf("Get exposed internal storage: %+v", a.Message)
	}
}
