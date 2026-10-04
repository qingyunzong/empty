package ownership

import (
	"errors"
	"sync"
	"testing"
	"time"
)

const testTTL = time.Minute

func newTestRegistry() (*Registry, *ManualClock) {
	clock := NewManualClock(time.Unix(1_700_000_000, 0))
	return NewWithClock(testTTL, clock), clock
}

func mustRegister(t *testing.T, r *Registry, name, owner string) Ticket {
	t.Helper()
	ticket, err := r.Register(name, owner)
	if err != nil {
		t.Fatalf("Register(%q, %q): %v", name, owner, err)
	}
	return ticket
}

func ownerOf(t *testing.T, r *Registry, name string) string {
	t.Helper()
	owner, _, ok := r.Owner(name)
	if !ok {
		t.Fatalf("Owner(%q): not found", name)
	}
	return owner
}

func TestPrepareKeepsOriginalOwner(t *testing.T) {
	r, _ := newTestRegistry()
	ticket := mustRegister(t, r, "res", "alice")

	if _, err := r.Prepare(ticket, "bob"); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if got := ownerOf(t, r, "res"); got != "alice" {
		t.Fatalf("owner during prepare = %q, want alice", got)
	}
	if !r.Pending("res") {
		t.Fatal("expected pending transfer")
	}
}

func TestConfirmTransfersAtomically(t *testing.T) {
	r, _ := newTestRegistry()
	ticket := mustRegister(t, r, "res", "alice")
	id, err := r.Prepare(ticket, "bob")
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}

	if err := r.Confirm("res", id); err != nil {
		t.Fatalf("Confirm: %v", err)
	}
	if got := ownerOf(t, r, "res"); got != "bob" {
		t.Fatalf("owner after confirm = %q, want bob", got)
	}
	if r.Pending("res") {
		t.Fatal("transfer still pending after confirm")
	}
}

func TestConfirmInvalidatesOldHolderTicket(t *testing.T) {
	r, _ := newTestRegistry()
	ticket := mustRegister(t, r, "res", "alice")
	id, _ := r.Prepare(ticket, "bob")
	if err := r.Confirm("res", id); err != nil {
		t.Fatalf("Confirm: %v", err)
	}

	// Alice's pre-transfer ticket is stale now.
	if _, err := r.Prepare(ticket, "carol"); !errors.Is(err, ErrStaleTicket) {
		t.Fatalf("Prepare with old holder ticket = %v, want ErrStaleTicket", err)
	}
	if err := r.Remove(ticket); !errors.Is(err, ErrStaleTicket) {
		t.Fatalf("Remove with old holder ticket = %v, want ErrStaleTicket", err)
	}
}

func TestWithdrawCancelsTransfer(t *testing.T) {
	r, _ := newTestRegistry()
	ticket := mustRegister(t, r, "res", "alice")
	id, _ := r.Prepare(ticket, "bob")

	if err := r.Withdraw("res", id); err != nil {
		t.Fatalf("Withdraw: %v", err)
	}
	if got := ownerOf(t, r, "res"); got != "alice" {
		t.Fatalf("owner after withdraw = %q, want alice", got)
	}
	if err := r.Confirm("res", id); !errors.Is(err, ErrNoTransfer) {
		t.Fatalf("Confirm after withdraw = %v, want ErrNoTransfer", err)
	}
}

func TestTimeoutWithdrawAndLateConfirmRejected(t *testing.T) {
	r, clock := newTestRegistry()
	ticket := mustRegister(t, r, "res", "alice")
	id, _ := r.Prepare(ticket, "bob")

	clock.Advance(2 * testTTL) // transfer deadline passes

	if err := r.Withdraw("res", id); err != nil {
		t.Fatalf("Withdraw after timeout: %v", err)
	}
	if err := r.Confirm("res", id); !errors.Is(err, ErrNoTransfer) {
		t.Fatalf("late Confirm after withdraw = %v, want ErrNoTransfer", err)
	}
	if got := ownerOf(t, r, "res"); got != "alice" {
		t.Fatalf("owner after timeout = %q, want alice", got)
	}
}

func TestLateConfirmWithoutWithdrawRejected(t *testing.T) {
	r, clock := newTestRegistry()
	ticket := mustRegister(t, r, "res", "alice")
	id, _ := r.Prepare(ticket, "bob")

	clock.Advance(2 * testTTL)

	if err := r.Confirm("res", id); !errors.Is(err, ErrTransferExpired) {
		t.Fatalf("late Confirm = %v, want ErrTransferExpired", err)
	}
	if got := ownerOf(t, r, "res"); got != "alice" {
		t.Fatalf("owner after late confirm = %q, want alice", got)
	}
	if r.Pending("res") {
		t.Fatal("expired transfer should be discarded by late confirm")
	}
}

func TestDoublePrepareRejected(t *testing.T) {
	r, _ := newTestRegistry()
	ticket := mustRegister(t, r, "res", "alice")
	if _, err := r.Prepare(ticket, "bob"); err != nil {
		t.Fatalf("first Prepare: %v", err)
	}
	if _, err := r.Prepare(ticket, "carol"); !errors.Is(err, ErrTransferPending) {
		t.Fatalf("second Prepare = %v, want ErrTransferPending", err)
	}
}

func TestGenerationTicketsHandleNameReuse(t *testing.T) {
	r, _ := newTestRegistry()
	old := mustRegister(t, r, "res", "alice")

	if err := r.Remove(old); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	reused := mustRegister(t, r, "res", "dave")
	if reused.Generation == old.Generation {
		t.Fatal("re-registered name reused a generation")
	}

	// The stale ticket from the previous incarnation must not work.
	if _, err := r.Prepare(old, "carol"); !errors.Is(err, ErrStaleTicket) {
		t.Fatalf("Prepare with stale ticket = %v, want ErrStaleTicket", err)
	}
	if err := r.Remove(old); !errors.Is(err, ErrStaleTicket) {
		t.Fatalf("Remove with stale ticket = %v, want ErrStaleTicket", err)
	}
	// The fresh ticket works.
	if _, err := r.Prepare(reused, "carol"); err != nil {
		t.Fatalf("Prepare with fresh ticket: %v", err)
	}
	if got := ownerOf(t, r, "res"); got != "dave" {
		t.Fatalf("owner = %q, want dave", got)
	}
}

func TestUnknownTransferAndResource(t *testing.T) {
	r, _ := newTestRegistry()
	mustRegister(t, r, "res", "alice")

	if err := r.Confirm("res", 999); !errors.Is(err, ErrNoTransfer) {
		t.Fatalf("Confirm unknown id = %v, want ErrNoTransfer", err)
	}
	if err := r.Confirm("ghost", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Confirm unknown name = %v, want ErrNotFound", err)
	}
	if _, err := r.Register("res", "bob"); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("re-Register live name = %v, want ErrAlreadyExists", err)
	}
	if _, err := r.Prepare(Ticket{Name: "res", Generation: 42}, "bob"); !errors.Is(err, ErrStaleTicket) {
		t.Fatalf("Prepare with forged generation = %v, want ErrStaleTicket", err)
	}
}

// TestConcurrentSmoke hammers the registry from many goroutines. Run with
// -race to check the mutex discipline; the exhaustive proof of the
// single-owner invariant is in interleave_test.go.
func TestConcurrentSmoke(t *testing.T) {
	r, _ := newTestRegistry()
	ticket := mustRegister(t, r, "res", "alice")

	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				owner, fresh, ok := r.Owner("res")
				if !ok || (owner != "alice" && owner != "bob") {
					t.Errorf("bad owner %q ok=%v", owner, ok)
					return
				}
				id, err := r.Prepare(fresh, "bob")
				if err == nil {
					_ = r.Confirm("res", id)
					_ = r.Withdraw("res", id)
				}
				_ = ticket
			}
		}(worker)
	}
	wg.Wait()
	if got := ownerOf(t, r, "res"); got != "alice" && got != "bob" {
		t.Fatalf("final owner = %q, want alice or bob", got)
	}
}
