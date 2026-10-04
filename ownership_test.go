package ownership

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// manualClock is a deterministic clock for timeout tests.
type manualClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *manualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *manualClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func newTestRegistry() (*Registry, *manualClock) {
	clock := &manualClock{now: time.Unix(1_700_000_000, 0)}
	return newRegistry(clock.Now), clock
}

func mustRegister(t *testing.T, r *Registry, name, owner string) Ticket {
	t.Helper()
	tk, err := r.Register(name, owner)
	if err != nil {
		t.Fatalf("Register(%q, %q): %v", name, owner, err)
	}
	return tk
}

func TestPrepareKeepsOriginalOwner(t *testing.T) {
	r, _ := newTestRegistry()
	tk := mustRegister(t, r, "res", "alice")

	if _, err := r.Prepare(tk, "alice", "bob", time.Minute); err != nil {
		t.Fatalf("Prepare: %v", err)
	}

	owner, live, ok := r.OwnerOf("res")
	if !ok || owner != "alice" {
		t.Fatalf("during prepare: owner = %q, ok = %v; want alice", owner, ok)
	}
	if live != tk {
		t.Fatalf("during prepare: generation changed: got %+v want %+v", live, tk)
	}
	recipient, pending := r.PendingTransfer("res")
	if !pending || recipient != "bob" {
		t.Fatalf("PendingTransfer = %q, %v; want bob, true", recipient, pending)
	}
	if snap := r.Owners(); snap["res"] != "alice" {
		t.Fatalf("Owners() during prepare = %q; want alice", snap["res"])
	}
}

func TestConfirmTransfersAtomically(t *testing.T) {
	r, _ := newTestRegistry()
	tk := mustRegister(t, r, "res", "alice")
	id, err := r.Prepare(tk, "alice", "bob", time.Minute)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}

	newTk, err := r.Confirm(id)
	if err != nil {
		t.Fatalf("Confirm: %v", err)
	}
	owner, live, ok := r.OwnerOf("res")
	if !ok || owner != "bob" {
		t.Fatalf("after confirm: owner = %q, ok = %v; want bob", owner, ok)
	}
	if live != newTk {
		t.Fatalf("live ticket %+v != confirmed ticket %+v", live, newTk)
	}
	if newTk.Gen <= tk.Gen {
		t.Fatalf("generation did not advance: old %d new %d", tk.Gen, newTk.Gen)
	}
	// Old holder can no longer operate with the stale ticket.
	if _, err := r.Prepare(tk, "alice", "carol", time.Minute); !errors.Is(err, ErrStaleTicket) {
		t.Fatalf("stale-ticket Prepare: err = %v; want ErrStaleTicket", err)
	}
	if _, pending := r.PendingTransfer("res"); pending {
		t.Fatal("transfer still pending after confirm")
	}
}

func TestLateConfirmRejected(t *testing.T) {
	r, clock := newTestRegistry()
	tk := mustRegister(t, r, "res", "alice")
	id, err := r.Prepare(tk, "alice", "bob", time.Minute)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}

	clock.Advance(2 * time.Minute) // deadline passed

	if _, err := r.Confirm(id); !errors.Is(err, ErrTransferExpired) {
		t.Fatalf("late Confirm: err = %v; want ErrTransferExpired", err)
	}
	owner, _, _ := r.OwnerOf("res")
	if owner != "alice" {
		t.Fatalf("after late confirm: owner = %q; want alice (timeout withdrawal)", owner)
	}
	// A second late confirm is rejected as no-longer-pending.
	if _, err := r.Confirm(id); !errors.Is(err, ErrTransferNotPending) {
		t.Fatalf("second Confirm: err = %v; want ErrTransferNotPending", err)
	}
}

func TestCancelWithdrawsTransfer(t *testing.T) {
	r, _ := newTestRegistry()
	tk := mustRegister(t, r, "res", "alice")
	id, err := r.Prepare(tk, "alice", "bob", time.Minute)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if err := r.Cancel(id); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if _, err := r.Confirm(id); !errors.Is(err, ErrTransferNotPending) {
		t.Fatalf("Confirm after cancel: err = %v; want ErrTransferNotPending", err)
	}
	owner, live, _ := r.OwnerOf("res")
	if owner != "alice" || live != tk {
		t.Fatalf("after cancel: owner = %q ticket = %+v; want alice, %+v", owner, live, tk)
	}
}

func TestExpireTimeoutsWithdraws(t *testing.T) {
	r, clock := newTestRegistry()
	tk := mustRegister(t, r, "a", "alice")
	mustRegister(t, r, "b", "alice")
	idA, err := r.Prepare(tk, "alice", "bob", time.Minute)
	if err != nil {
		t.Fatalf("Prepare a: %v", err)
	}
	_, tkB, _ := r.OwnerOf("b")
	if _, err := r.Prepare(tkB, "alice", "carol", time.Hour); err != nil {
		t.Fatalf("Prepare b: %v", err)
	}

	clock.Advance(2 * time.Minute) // only a's deadline passed

	if n := r.ExpireTimeouts(); n != 1 {
		t.Fatalf("ExpireTimeouts = %d; want 1", n)
	}
	if _, err := r.Confirm(idA); !errors.Is(err, ErrTransferNotPending) {
		t.Fatalf("Confirm expired a: err = %v; want ErrTransferNotPending", err)
	}
	if owner, _, _ := r.OwnerOf("a"); owner != "alice" {
		t.Fatalf("owner of a = %q; want alice", owner)
	}
	if recipient, pending := r.PendingTransfer("b"); !pending || recipient != "carol" {
		t.Fatalf("b transfer lost: %q, %v; want carol, true", recipient, pending)
	}
}

func TestGenerationTicketHandlesNameReuse(t *testing.T) {
	r, _ := newTestRegistry()
	oldTk := mustRegister(t, r, "res", "alice")
	if err := r.Release(oldTk, "alice"); err != nil {
		t.Fatalf("Release: %v", err)
	}

	newTk := mustRegister(t, r, "res", "carol") // same name, new incarnation
	if newTk.Gen == oldTk.Gen {
		t.Fatal("generation reused after name reuse")
	}

	// The old holder's ticket must not work on the new incarnation.
	if _, err := r.Prepare(oldTk, "alice", "bob", time.Minute); !errors.Is(err, ErrStaleTicket) {
		t.Fatalf("Prepare with stale ticket: err = %v; want ErrStaleTicket", err)
	}
	if err := r.Release(oldTk, "alice"); !errors.Is(err, ErrStaleTicket) {
		t.Fatalf("Release with stale ticket: err = %v; want ErrStaleTicket", err)
	}
	// The new owner operates normally.
	if _, err := r.Prepare(newTk, "carol", "dave", time.Minute); err != nil {
		t.Fatalf("Prepare with fresh ticket: %v", err)
	}
}

func TestReleaseWithPendingTransferWithdraws(t *testing.T) {
	r, _ := newTestRegistry()
	tk := mustRegister(t, r, "res", "alice")
	id, err := r.Prepare(tk, "alice", "bob", time.Minute)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if err := r.Release(tk, "alice"); err != nil {
		t.Fatalf("Release: %v", err)
	}
	if _, err := r.Confirm(id); !errors.Is(err, ErrTransferNotPending) {
		t.Fatalf("Confirm after release: err = %v; want ErrTransferNotPending", err)
	}
}

func TestExactlyOneOwnerUnderInterleaving(t *testing.T) {
	// Deterministic interleaving proof: at every step of the protocol —
	// before prepare, after prepare, after confirm, after timeout — an
	// enumeration observes exactly one owner for the resource.
	r, clock := newTestRegistry()
	tk := mustRegister(t, r, "res", "alice")

	assertSoleOwner := func(step, want string) {
		t.Helper()
		snap := r.Owners()
		owner, ok := snap["res"]
		if !ok {
			t.Fatalf("%s: resource missing from enumeration", step)
		}
		if owner != want {
			t.Fatalf("%s: owner = %q; want %q", step, owner, want)
		}
		if len(snap) != 1 {
			t.Fatalf("%s: enumeration has %d entries; want exactly 1", step, len(snap))
		}
	}

	assertSoleOwner("registered", "alice")

	id, err := r.Prepare(tk, "alice", "bob", time.Minute)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	assertSoleOwner("prepared (original holder still owns)", "alice")

	if _, err := r.Confirm(id); err != nil {
		t.Fatalf("Confirm: %v", err)
	}
	assertSoleOwner("confirmed (recipient owns)", "bob")

	// Timeout path: prepare again then let it lapse.
	_, tk2, _ := r.OwnerOf("res")
	id2, err := r.Prepare(tk2, "bob", "carol", time.Minute)
	if err != nil {
		t.Fatalf("Prepare 2: %v", err)
	}
	assertSoleOwner("prepared again", "bob")
	clock.Advance(2 * time.Minute)
	if _, err := r.Confirm(id2); !errors.Is(err, ErrTransferExpired) {
		t.Fatalf("late Confirm: err = %v; want ErrTransferExpired", err)
	}
	assertSoleOwner("after timeout withdrawal", "bob")
}

func TestConcurrentInterleavingKeepsExactlyOneOwner(t *testing.T) {
	// Stress proof: many goroutines interleave register / prepare /
	// confirm / cancel / release while an enumerator continuously checks
	// the invariant that every live resource has exactly one owner and
	// that a pending transfer never creates a second (or zero) owner.
	r := NewRegistry()
	const workers = 8
	const iterations = 500

	var workersWg sync.WaitGroup
	var bgWg sync.WaitGroup
	stop := make(chan struct{})

	// Enumerator: continuously verify the exactly-one-owner invariant.
	bgWg.Add(1)
	go func() {
		defer bgWg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			snap := r.Owners()
			for name, owner := range snap {
				if owner == "" {
					t.Errorf("resource %q enumerated with no owner", name)
					continue
				}
				// A pending transfer must not change the sole owner:
				// the designated recipient must not already appear as
				// owner of this resource.
				if recipient, pending := r.PendingTransfer(name); pending && recipient == owner {
					// Only an error if recipient is recorded as owner
					// while the transfer is still pending.
					t.Errorf("resource %q: pending recipient %q already owns it", name, recipient)
				}
			}
		}
	}()

	for w := 0; w < workers; w++ {
		workersWg.Add(1)
		go func(w int) {
			defer workersWg.Done()
			name := fmt.Sprintf("res-%d", w%4)
			me := fmt.Sprintf("owner-%d", w)
			for i := 0; i < iterations; i++ {
				tk, err := r.Register(name, me)
				if err != nil {
					// Someone else holds the name; try to take it via transfer.
					owner, live, ok := r.OwnerOf(name)
					if !ok {
						continue
					}
					if owner == me {
						continue // already ours; a self-transfer is not interesting
					}
					id, err := r.Prepare(live, owner, me, 50*time.Millisecond)
					if err != nil {
						continue
					}
					if i%3 == 0 {
						_ = r.Cancel(id)
						continue
					}
					_, _ = r.Confirm(id)
					continue
				}
				// We own a fresh incarnation; sometimes release it so the
				// name gets reused with a new generation.
				if i%2 == 0 {
					_ = r.Release(tk, me)
				}
			}
		}(w)
	}

	// Timeout sweeper runs alongside everything.
	bgWg.Add(1)
	go func() {
		defer bgWg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				r.ExpireTimeouts()
				time.Sleep(time.Millisecond)
			}
		}
	}()

	workersWg.Wait()
	close(stop)
	bgWg.Wait()

	// Final check: every remaining resource has exactly one owner.
	for name, owner := range r.Owners() {
		if owner == "" {
			t.Errorf("final: resource %q has no owner", name)
		}
	}
}
