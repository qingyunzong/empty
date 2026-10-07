package sched

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeClock struct{ now int64 }

func (c *fakeClock) get() int64 { return c.now }

func openTest(t *testing.T, path string, clock *fakeClock, ttl int64) *Scheduler {
	t.Helper()
	s, err := Open(path, WithClock(clock.get), WithLeaseTTL(ttl))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func mustAdd(t *testing.T, s *Scheduler, tasks ...Task) {
	t.Helper()
	for _, task := range tasks {
		if err := s.Add(task); err != nil {
			t.Fatalf("Add(%q): %v", task.ID, err)
		}
	}
}

func mustClaim(t *testing.T, s *Scheduler) ClaimToken {
	t.Helper()
	tok, ok, err := s.Claim()
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if !ok {
		t.Fatalf("Claim: no task available")
	}
	return tok
}

func TestClaimOrderByDeadlineThenID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sched.log")
	clock := &fakeClock{now: 1000}
	s := openTest(t, path, clock, 10)
	defer s.Close()

	mustAdd(t, s,
		Task{ID: "c", Deadline: 5},
		Task{ID: "b", Deadline: 1},
		Task{ID: "a2", Deadline: 1},
		Task{ID: "a1", Deadline: 1},
		Task{ID: "d", Deadline: 9},
	)
	want := []string{"a1", "a2", "b", "c", "d"}
	for i, id := range want {
		tok := mustClaim(t, s)
		if tok.TaskID != id {
			t.Fatalf("claim %d: got %q, want %q", i, tok.TaskID, id)
		}
		if tok.Generation != int64(i+1) {
			t.Fatalf("claim %d: generation = %d, want %d", i, tok.Generation, i+1)
		}
		if _, err := s.Ack(tok.TaskID, tok.Generation); err != nil {
			t.Fatalf("Ack(%q): %v", tok.TaskID, err)
		}
	}
	if _, ok, err := s.Claim(); err != nil || ok {
		t.Fatalf("Claim after drain: ok=%v err=%v, want none", ok, err)
	}
}

// A returned claim token must already be durable: the hook runs after
// fsync but before Claim returns, and must find the record on disk.
func TestClaimPersistedBeforeReturn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sched.log")
	clock := &fakeClock{now: 100}
	s := openTest(t, path, clock, 10)
	defer s.Close()
	mustAdd(t, s, Task{ID: "t1", Deadline: 1})

	seenOnDisk := false
	s.afterPersist = func(op string) {
		if op != opClaim {
			return
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("read log: %v", err)
			return
		}
		if strings.Contains(string(data), `"op":"claim"`) && strings.Contains(string(data), `"id":"t1"`) {
			seenOnDisk = true
		}
	}
	tok := mustClaim(t, s)
	if !seenOnDisk {
		t.Fatal("claim record not found on disk before Claim returned")
	}
	if tok.LeaseExpiry != 110 {
		t.Fatalf("LeaseExpiry = %d, want 110", tok.LeaseExpiry)
	}
}

// Crash injection: the process dies after the claim record is fsynced
// but before Claim returns. After restart the task must not be lost or
// double-claimed while the lease lives; once expired it is re-claimed
// with a new generation, and the old generation's ack is rejected.
func TestCrashAfterClaimPersist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sched.log")
	clock := &fakeClock{now: 100}
	s := openTest(t, path, clock, 10)
	mustAdd(t, s, Task{ID: "job", Deadline: 1})

	crash := errors.New("simulated crash")
	s.afterPersist = func(op string) {
		if op == opClaim {
			panic(crash)
		}
	}
	func() {
		defer func() {
			if r := recover(); r != crash {
				t.Fatalf("panic = %v, want simulated crash", r)
			}
		}()
		s.Claim()
	}()
	s.Close() // process "dies"; in-memory state is discarded

	clock.now = 105 // lease (expiry 110) still valid
	s2 := openTest(t, path, clock, 10)
	defer s2.Close()

	st, err := s2.Status("job")
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if st.State != StateLeased || st.Generation != 1 || st.LeaseExpiry != 110 {
		t.Fatalf("after restart: %+v, want leased gen=1 expiry=110", st)
	}
	if _, ok, err := s2.Claim(); err != nil || ok {
		t.Fatalf("Claim during live lease: ok=%v err=%v, want none", ok, err)
	}

	clock.now = 111 // lease expired: unacked task becomes claimable again
	tok := mustClaim(t, s2)
	if tok.TaskID != "job" || tok.Generation != 2 {
		t.Fatalf("re-claim = %+v, want job gen=2", tok)
	}
	if _, err := s2.Ack("job", 1); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("Ack old generation: %v, want ErrStaleGeneration", err)
	}
	if _, err := s2.Ack("job", 2); err != nil {
		t.Fatalf("Ack current generation: %v", err)
	}
	if st, _ := s2.Status("job"); st.State != StateDone {
		t.Fatalf("final state = %v, want done", st.State)
	}
}

func TestExpiredAckRejected(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sched.log")
	clock := &fakeClock{now: 50}
	s := openTest(t, path, clock, 10)
	defer s.Close()
	mustAdd(t, s, Task{ID: "x", Deadline: 1})

	tok := mustClaim(t, s)
	clock.now = tok.LeaseExpiry + 1
	if _, err := s.Ack("x", tok.Generation); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("Ack after expiry: %v, want ErrLeaseExpired", err)
	}
	// Expired lease means the task is claimable again with a new generation.
	tok2 := mustClaim(t, s)
	if tok2.Generation != tok.Generation+1 {
		t.Fatalf("re-claim generation = %d, want %d", tok2.Generation, tok.Generation+1)
	}
	if _, err := s.Ack("x", tok2.Generation); err != nil {
		t.Fatalf("Ack re-claimed task: %v", err)
	}
}

func TestAckValidation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sched.log")
	clock := &fakeClock{now: 0}
	s := openTest(t, path, clock, 10)
	defer s.Close()
	mustAdd(t, s, Task{ID: "a", Deadline: 1})

	if _, err := s.Ack("ghost", 1); !errors.Is(err, ErrUnknownTask) {
		t.Fatalf("Ack unknown: %v, want ErrUnknownTask", err)
	}
	if _, err := s.Ack("a", 1); !errors.Is(err, ErrNotLeased) {
		t.Fatalf("Ack unclaimed: %v, want ErrNotLeased", err)
	}
	tok := mustClaim(t, s)
	if _, err := s.Ack("a", tok.Generation+9); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("Ack wrong generation: %v, want ErrStaleGeneration", err)
	}
	if _, err := s.Ack("a", tok.Generation); err != nil {
		t.Fatalf("Ack: %v", err)
	}
	if _, err := s.Ack("a", tok.Generation); !errors.Is(err, ErrAlreadyDone) {
		t.Fatalf("duplicate Ack: %v, want ErrAlreadyDone", err)
	}
}

// flakyWriter injects persistence failures.
type flakyWriter struct {
	inner     syncWriter
	failWrite bool
	failSync  bool
}

func (w *flakyWriter) Write(p []byte) (int, error) {
	if w.failWrite {
		return 0, errors.New("injected write failure")
	}
	return w.inner.Write(p)
}

func (w *flakyWriter) Sync() error {
	if w.failSync {
		return errors.New("injected sync failure")
	}
	return w.inner.Sync()
}

// A failed persist must surface an error and leave state untouched, so
// the same task is claimed again with the same generation afterwards.
func TestPersistFailureLeavesStateUntouched(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sched.log")
	clock := &fakeClock{now: 0}
	s := openTest(t, path, clock, 10)
	defer s.Close()
	fw := &flakyWriter{inner: s.w}
	s.w = fw
	mustAdd(t, s, Task{ID: "a", Deadline: 1})

	fw.failSync = true
	if _, _, err := s.Claim(); err == nil {
		t.Fatal("Claim with failing sync: want error")
	}
	if st, _ := s.Status("a"); st.State != StatePending || st.Generation != 0 {
		t.Fatalf("state after failed claim: %+v, want pending gen=0", st)
	}
	fw.failSync = false
	fw.failWrite = true
	if _, _, err := s.Claim(); err == nil {
		t.Fatal("Claim with failing write: want error")
	}
	fw.failWrite = false

	tok := mustClaim(t, s)
	if tok.Generation != 1 {
		t.Fatalf("generation after failures = %d, want 1 (no generation burned)", tok.Generation)
	}
	if _, err := s.Ack("a", 1); err != nil {
		t.Fatalf("Ack: %v", err)
	}
}

// Combined scenario: crash injection plus out-of-order acknowledgements,
// verifying every task's state and every piece of returned evidence.
func TestCrashAndOutOfOrderAcks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sched.log")
	clock := &fakeClock{now: 1000}
	s := openTest(t, path, clock, 100)
	mustAdd(t, s,
		Task{ID: "t1", Deadline: 3},
		Task{ID: "t2", Deadline: 1},
		Task{ID: "t3", Deadline: 2},
	)

	// Claim t2 and t3, then crash on t1's claim persist.
	tok2 := mustClaim(t, s)
	tok3 := mustClaim(t, s)
	s.afterPersist = func(op string) {
		if op == opClaim {
			panic("boom")
		}
	}
	func() {
		defer func() { recover() }()
		s.Claim()
	}()
	s.Close()

	// Restart: t1's claim survived the crash; t2/t3 still leased.
	s2 := openTest(t, path, clock, 100)
	tokens := map[string]ClaimToken{"t2": tok2, "t3": tok3}
	st1, err := s2.Status("t1")
	if err != nil || st1.State != StateLeased {
		t.Fatalf("t1 after restart: %+v err=%v, want leased", st1, err)
	}
	tokens["t1"] = ClaimToken{TaskID: "t1", Generation: st1.Generation, LeaseExpiry: st1.LeaseExpiry}

	// Out-of-order acks: t3, t1, then t2. Each receipt must echo the
	// claim evidence.
	for _, id := range []string{"t3", "t1", "t2"} {
		tok := tokens[id]
		rc, err := s2.Ack(id, tok.Generation)
		if err != nil {
			t.Fatalf("Ack(%q): %v", id, err)
		}
		if rc.TaskID != id || rc.Generation != tok.Generation || rc.AckedAt != clock.now {
			t.Fatalf("receipt for %q = %+v, want gen=%d ackedAt=%d", id, rc, tok.Generation, clock.now)
		}
	}

	// All tasks done, in (Deadline, ID) order.
	snap := s2.Snapshot()
	wantOrder := []string{"t2", "t3", "t1"}
	if len(snap) != 3 {
		t.Fatalf("snapshot len = %d, want 3", len(snap))
	}
	for i, st := range snap {
		if st.Task.ID != wantOrder[i] || st.State != StateDone {
			t.Fatalf("snapshot[%d] = %q/%v, want %q/done", i, st.Task.ID, st.State, wantOrder[i])
		}
	}
	if _, ok, err := s2.Claim(); err != nil || ok {
		t.Fatalf("Claim after all done: ok=%v err=%v, want none", ok, err)
	}

	// Final restart: everything is still done; nothing is claimable.
	s2.Close()
	s3 := openTest(t, path, clock, 100)
	defer s3.Close()
	for _, st := range s3.Snapshot() {
		if st.State != StateDone {
			t.Fatalf("after final restart %q = %v, want done", st.Task.ID, st.State)
		}
	}
	if _, ok, err := s3.Claim(); err != nil || ok {
		t.Fatalf("Claim on final restart: ok=%v err=%v, want none", ok, err)
	}
}

// Unacked tasks survive a restart and are re-claimed with a strictly
// increasing generation, even across multiple crashes.
func TestRestartReclaimNewGeneration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sched.log")
	clock := &fakeClock{now: 0}
	s := openTest(t, path, clock, 5)
	mustAdd(t, s, Task{ID: "job", Deadline: 1})

	for cycle := int64(1); cycle <= 3; cycle++ {
		tok := mustClaim(t, s)
		if tok.Generation != cycle {
			t.Fatalf("cycle %d: generation = %d", cycle, tok.Generation)
		}
		s.Close()       // crash without ack
		clock.now += 10 // past every lease
		s = openTest(t, path, clock, 5)
	}
	defer s.Close()
	tok := mustClaim(t, s)
	if tok.Generation != 4 {
		t.Fatalf("generation after restarts = %d, want 4", tok.Generation)
	}
	if _, err := s.Ack("job", 2); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("Ack gen 2: %v, want ErrStaleGeneration", err)
	}
	if _, err := s.Ack("job", 4); err != nil {
		t.Fatalf("Ack gen 4: %v", err)
	}
}

func TestAddValidationAndDurability(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sched.log")
	clock := &fakeClock{now: 0}
	s := openTest(t, path, clock, 5)
	if err := s.Add(Task{Deadline: 1}); !errors.Is(err, ErrEmptyID) {
		t.Fatalf("Add empty id: %v, want ErrEmptyID", err)
	}
	mustAdd(t, s, Task{ID: "a", Deadline: 7, Payload: []byte("hello")})
	if err := s.Add(Task{ID: "a", Deadline: 9}); !errors.Is(err, ErrDuplicateTask) {
		t.Fatalf("Add duplicate: %v, want ErrDuplicateTask", err)
	}
	s.Close()

	s2 := openTest(t, path, clock, 5)
	defer s2.Close()
	st, err := s2.Status("a")
	if err != nil {
		t.Fatalf("Status after restart: %v", err)
	}
	if st.Task.Deadline != 7 || string(st.Task.Payload) != "hello" || st.State != StatePending {
		t.Fatalf("restored task = %+v, want deadline=7 payload=hello pending", st)
	}
}
