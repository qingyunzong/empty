package scheduler

import (
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
)

// clock is a manual logical clock so lease expiry is deterministic.
type clock struct{ t int64 }

func (c *clock) now() int64      { return c.t }
func (c *clock) advance(d int64) { c.t += d }

func open(t *testing.T, path string, lease int64, c *clock) *Scheduler {
	t.Helper()
	s, err := Open(path, lease, c.now)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

// reopen simulates a clean restart: close and open again from the same log.
func reopen(t *testing.T, s *Scheduler, path string, lease int64, c *clock) *Scheduler {
	t.Helper()
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	return open(t, path, lease, c)
}

// errSimulatedCrash is panicked by the crash hook to kill the scheduler
// mid-operation, the way a process crash would.
var errSimulatedCrash = errors.New("simulated crash")

// crashAt arms s to crash at the given persistence stage: the log file is
// closed without flushing the unsynced buffer, then the hook panics.
func crashAt(s *Scheduler, target string) {
	s.crashHook = func(stage string) {
		if stage == target {
			s.st.close()
			panic(errSimulatedCrash)
		}
	}
}

// survive runs fn, expecting a simulated-crash panic.
func survive(t *testing.T, fn func()) {
	t.Helper()
	defer func() {
		if r := recover(); r != errSimulatedCrash {
			t.Fatalf("expected simulated crash, got %v", r)
		}
	}()
	fn()
}

func mustAdd(t *testing.T, s *Scheduler, id string, deadline int64, payload string) {
	t.Helper()
	if err := s.Add(id, deadline, payload); err != nil {
		t.Fatalf("Add(%s): %v", id, err)
	}
}

func mustClaim(t *testing.T, s *Scheduler) Claim {
	t.Helper()
	c, ok, err := s.Claim()
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if !ok {
		t.Fatalf("Claim: no task available")
	}
	return c
}

func mustAck(t *testing.T, s *Scheduler, id string, gen int) {
	t.Helper()
	if err := s.Ack(id, gen); err != nil {
		t.Fatalf("Ack(%s, %d): %v", id, gen, err)
	}
}

// states flattens a snapshot into "id:state" strings for easy comparison.
func states(snap []Task) []string {
	out := make([]string, 0, len(snap))
	for _, task := range snap {
		out = append(out, fmt.Sprintf("%s:%s", task.ID, task.State))
	}
	return out
}

func TestClaimOrderByDeadlineThenID(t *testing.T) {
	c := &clock{}
	s := open(t, filepath.Join(t.TempDir(), "log"), 10, c)

	mustAdd(t, s, "b", 5, "pb")
	mustAdd(t, s, "a", 5, "pa")
	mustAdd(t, s, "d", 2, "pd")
	mustAdd(t, s, "c", 2, "pc")

	want := []string{"c", "d", "a", "b"}
	for i, id := range want {
		cl := mustClaim(t, s)
		if cl.Task.ID != id {
			t.Fatalf("claim %d: got %s, want %s", i, cl.Task.ID, id)
		}
		if cl.Generation != 1 {
			t.Fatalf("claim %s: generation %d, want 1", id, cl.Generation)
		}
		if cl.Expiry != c.now()+10 {
			t.Fatalf("claim %s: expiry %d, want %d", id, cl.Expiry, c.now()+10)
		}
	}
	if _, ok, err := s.Claim(); err != nil || ok {
		t.Fatalf("expected no claimable task, got ok=%v err=%v", ok, err)
	}
}

func TestClaimIsDurableBeforeReturn(t *testing.T) {
	stages := []string{StageBeforeWrite, StageBeforeSync, StageAfterSync}
	for _, stage := range stages {
		t.Run(stage, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "log")
			c := &clock{}
			s := open(t, path, 10, c)
			mustAdd(t, s, "t1", 1, "p")

			crashAt(s, stage)
			survive(t, func() { _, _, _ = s.Claim() })

			// Recover from whatever reached the disk.
			s2 := open(t, path, 10, c)
			snap := s2.Snapshot()
			if len(snap) != 1 {
				t.Fatalf("snapshot len %d, want 1", len(snap))
			}
			if stage == StageAfterSync {
				// The claim record was fsynced before the crash, so the
				// claim must be visible after recovery even though the
				// caller never saw the return value.
				if snap[0].State != Claimed || snap[0].Generation != 1 {
					t.Fatalf("got %v gen %d, want claimed gen 1", snap[0].State, snap[0].Generation)
				}
			} else {
				// The claim record never reached disk; the task must be
				// untouched and claimable again with generation 1.
				if snap[0].State != Pending || snap[0].Generation != 0 {
					t.Fatalf("got %v gen %d, want pending gen 0", snap[0].State, snap[0].Generation)
				}
				cl := mustClaim(t, s2)
				if cl.Generation != 1 {
					t.Fatalf("re-claim generation %d, want 1", cl.Generation)
				}
			}
		})
	}
}

func TestRestartUnackedReclaimableWithNewGeneration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	c := &clock{}
	s := open(t, path, 10, c)

	mustAdd(t, s, "t1", 1, "p")
	first := mustClaim(t, s)
	if first.Generation != 1 {
		t.Fatalf("first claim generation %d, want 1", first.Generation)
	}

	// Restart without acking.
	s = reopen(t, s, path, 10, c)
	snap := s.Snapshot()
	if snap[0].State != Claimed || snap[0].Generation != 1 {
		t.Fatalf("after restart: %v gen %d, want claimed gen 1", snap[0].State, snap[0].Generation)
	}

	// Once the lease lapses the task is claimable again, with a new generation.
	c.advance(11)
	second := mustClaim(t, s)
	if second.Task.ID != "t1" || second.Generation != 2 {
		t.Fatalf("re-claim: id %s gen %d, want t1 gen 2", second.Task.ID, second.Generation)
	}

	// The old generation's ACK is now stale and must be rejected.
	if err := s.Ack("t1", first.Generation); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale ack: %v, want ErrStaleGeneration", err)
	}
	mustAck(t, s, "t1", second.Generation)
	if got := states(s.Snapshot()); !reflect.DeepEqual(got, []string{"t1:done"}) {
		t.Fatalf("states %v, want [t1:done]", got)
	}
}

func TestExpiredAckRejected(t *testing.T) {
	c := &clock{}
	s := open(t, filepath.Join(t.TempDir(), "log"), 5, c)

	mustAdd(t, s, "t1", 1, "p")
	cl := mustClaim(t, s) // lease expires at t=5

	c.advance(6) // now past the lease
	if err := s.Ack("t1", cl.Generation); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("expired ack: %v, want ErrLeaseExpired", err)
	}
	// The failed ack must not have changed anything.
	if snap := s.Snapshot(); snap[0].State != Claimed || snap[0].Generation != 1 {
		t.Fatalf("after rejected ack: %v gen %d, want claimed gen 1", snap[0].State, snap[0].Generation)
	}

	// The expired claim frees the task; the next claim gets a new generation.
	cl2 := mustClaim(t, s)
	if cl2.Generation != 2 {
		t.Fatalf("re-claim generation %d, want 2", cl2.Generation)
	}
	mustAck(t, s, "t1", cl2.Generation)
}

func TestAckValidation(t *testing.T) {
	c := &clock{}
	s := open(t, filepath.Join(t.TempDir(), "log"), 10, c)
	mustAdd(t, s, "t1", 1, "p")

	if err := s.Ack("ghost", 1); !errors.Is(err, ErrTaskNotFound) {
		t.Fatalf("ack unknown: %v, want ErrTaskNotFound", err)
	}
	if err := s.Ack("t1", 1); !errors.Is(err, ErrNotClaimed) {
		t.Fatalf("ack pending: %v, want ErrNotClaimed", err)
	}
	cl := mustClaim(t, s)
	if err := s.Ack("t1", cl.Generation+1); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("ack wrong gen: %v, want ErrStaleGeneration", err)
	}
	mustAck(t, s, "t1", cl.Generation)
	if err := s.Ack("t1", cl.Generation); !errors.Is(err, ErrAlreadyDone) {
		t.Fatalf("double ack: %v, want ErrAlreadyDone", err)
	}
}

func TestOutOfOrderAcksAndFullState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	c := &clock{}
	s := open(t, path, 10, c)

	// Deadlines chosen so claim order differs from insertion order.
	mustAdd(t, s, "a", 2, "pa")
	mustAdd(t, s, "b", 1, "pb")
	mustAdd(t, s, "c", 2, "pc")
	mustAdd(t, s, "d", 1, "pd")

	// Claim order must be b, d, a, c.
	var claims []Claim
	for _, wantID := range []string{"b", "d", "a"} {
		cl := mustClaim(t, s)
		if cl.Task.ID != wantID {
			t.Fatalf("claim: got %s, want %s", cl.Task.ID, wantID)
		}
		claims = append(claims, cl)
	}
	if got := states(s.Snapshot()); !reflect.DeepEqual(got, []string{"b:claimed", "d:claimed", "a:claimed", "c:pending"}) {
		t.Fatalf("states %v", got)
	}

	// Ack out of order: d first, then b. Every ack must return nil and each
	// intermediate state must be exactly right.
	mustAck(t, s, "d", claims[1].Generation)
	if got := states(s.Snapshot()); !reflect.DeepEqual(got, []string{"b:claimed", "d:done", "a:claimed", "c:pending"}) {
		t.Fatalf("states %v", got)
	}
	mustAck(t, s, "b", claims[0].Generation)
	if got := states(s.Snapshot()); !reflect.DeepEqual(got, []string{"b:done", "d:done", "a:claimed", "c:pending"}) {
		t.Fatalf("states %v", got)
	}

	// Restart: the done tasks stay done, the live claim survives, and the
	// pending task is still claimable.
	s = reopen(t, s, path, 10, c)
	if got := states(s.Snapshot()); !reflect.DeepEqual(got, []string{"b:done", "d:done", "a:claimed", "c:pending"}) {
		t.Fatalf("states after restart %v", got)
	}

	// Ack the surviving claim, then claim and ack the rest out of order.
	mustAck(t, s, "a", claims[2].Generation)
	cl := mustClaim(t, s)
	if cl.Task.ID != "c" {
		t.Fatalf("claim: got %s, want c", cl.Task.ID)
	}
	mustAck(t, s, "c", cl.Generation)
	if got := states(s.Snapshot()); !reflect.DeepEqual(got, []string{"b:done", "d:done", "a:done", "c:done"}) {
		t.Fatalf("final states %v", got)
	}
	if _, ok, err := s.Claim(); err != nil || ok {
		t.Fatalf("expected drained scheduler, got ok=%v err=%v", ok, err)
	}
}

// TestCrashInjectionMatrix injects a crash at every persistence stage of
// every operation in a mixed workload (adds, claims, out-of-order acks) and,
// after each recovery, verifies every task's state against a model that
// accounts for exactly which records were durable at the crash point.
func TestCrashInjectionMatrix(t *testing.T) {
	stages := []string{StageBeforeWrite, StageBeforeSync, StageAfterSync}
	for _, stage := range stages {
		t.Run(stage, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "log")
			c := &clock{}
			s := open(t, path, 10, c)

			mustAdd(t, s, "x", 1, "px")
			mustAdd(t, s, "y", 2, "py")
			mustAdd(t, s, "z", 3, "pz")

			// Crash mid-claim of x.
			crashAt(s, stage)
			survive(t, func() { _, _, _ = s.Claim() })
			s = open(t, path, 10, c)

			xClaimed := stage == StageAfterSync
			want := []string{"x:pending", "y:pending", "z:pending"}
			if xClaimed {
				want[0] = "x:claimed"
			}
			if got := states(s.Snapshot()); !reflect.DeepEqual(got, want) {
				t.Fatalf("after claim crash: %v, want %v", got, want)
			}

			// Claim x and y for real (x may be a re-claim after lease expiry).
			if xClaimed {
				c.advance(11) // expire the crashed claim's lease
			}
			cx := mustClaim(t, s)
			if cx.Task.ID != "x" {
				t.Fatalf("claim: got %s, want x", cx.Task.ID)
			}
			cy := mustClaim(t, s)
			if cy.Task.ID != "y" {
				t.Fatalf("claim: got %s, want y", cy.Task.ID)
			}

			// Crash mid-ack of y (acked before x: out of order).
			crashAt(s, stage)
			survive(t, func() { _ = s.Ack("y", cy.Generation) })
			s = open(t, path, 10, c)

			yDone := stage == StageAfterSync
			wantY := "y:claimed"
			if yDone {
				wantY = "y:done"
			}
			if got := states(s.Snapshot()); !reflect.DeepEqual(got, []string{"x:claimed", wantY, "z:pending"}) {
				t.Fatalf("after ack crash: %v (wantY=%s)", got, wantY)
			}

			// Finish everything with out-of-order acks and verify all states.
			if !yDone {
				mustAck(t, s, "y", cy.Generation)
			}
			mustAck(t, s, "x", cx.Generation)
			cz := mustClaim(t, s)
			mustAck(t, s, "z", cz.Generation)
			if got := states(s.Snapshot()); !reflect.DeepEqual(got, []string{"x:done", "y:done", "z:done"}) {
				t.Fatalf("final states %v", got)
			}

			// One more restart: the final state must be fully durable.
			s = reopen(t, s, path, 10, c)
			if got := states(s.Snapshot()); !reflect.DeepEqual(got, []string{"x:done", "y:done", "z:done"}) {
				t.Fatalf("states after final restart %v", got)
			}
			if err := s.Close(); err != nil {
				t.Fatalf("Close: %v", err)
			}
		})
	}
}
