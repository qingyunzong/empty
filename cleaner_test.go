package leasecleaner

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fakeClock is a manually advanced, goroutine-safe clock.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
}

func (f *fakeClock) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *fakeClock) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d)
}

func mustStage(t *testing.T, c *Cleaner, name, data string, deadline time.Time) uint64 {
	t.Helper()
	gen, err := c.Stage(name, []byte(data), deadline)
	if err != nil {
		t.Fatalf("Stage(%s): %v", name, err)
	}
	return gen
}

func fileExists(t *testing.T, dir, name string) bool {
	t.Helper()
	_, err := os.Stat(filepath.Join(dir, name))
	if err == nil {
		return true
	}
	if os.IsNotExist(err) {
		return false
	}
	t.Fatalf("stat %s: %v", name, err)
	return false
}

// Expiry is decided by now >= deadline: a file whose deadline equals now
// is reclaimed, one whose deadline is even slightly later is kept.
func TestExpiryBoundary(t *testing.T) {
	dir := t.TempDir()
	clock := newFakeClock()
	c, err := Open(dir, clock.Now)
	if err != nil {
		t.Fatal(err)
	}
	t0 := clock.Now()
	mustStage(t, c, "a", "A", t0.Add(time.Minute))
	mustStage(t, c, "b", "B", t0.Add(2*time.Minute))

	clock.Advance(time.Minute) // now == a.deadline
	n, err := c.ReapExpired()
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("reaped %d, want 1", n)
	}
	if fileExists(t, dir, "a") {
		t.Fatal("a must be reclaimed at now == deadline")
	}
	if !fileExists(t, dir, "b") {
		t.Fatal("b must survive before its deadline")
	}

	clock.Advance(time.Minute - time.Nanosecond) // now < b.deadline
	if n, _ := c.ReapExpired(); n != 0 {
		t.Fatalf("reaped %d before deadline, want 0", n)
	}
	clock.Advance(time.Nanosecond) // now == b.deadline
	if n, _ := c.ReapExpired(); n != 1 {
		t.Fatalf("reaped %d at deadline, want 1", n)
	}
	if fileExists(t, dir, "b") {
		t.Fatal("b must be reclaimed at now == deadline")
	}
}

// Renewal and deletion are decided in the same critical section: a
// renewal that lands before the reaper wins, even if the old deadline
// has already passed.
func TestRenewBeatsReap(t *testing.T) {
	dir := t.TempDir()
	clock := newFakeClock()
	c, err := Open(dir, clock.Now)
	if err != nil {
		t.Fatal(err)
	}
	t0 := clock.Now()
	gen := mustStage(t, c, "f", "v1", t0.Add(time.Minute))

	clock.Advance(2 * time.Minute) // original deadline long past
	if err := c.Renew("f", gen, clock.Now().Add(time.Hour)); err != nil {
		t.Fatalf("Renew: %v", err)
	}
	if n, _ := c.ReapExpired(); n != 0 {
		t.Fatalf("reaped %d after renewal, want 0", n)
	}
	if !fileExists(t, dir, "f") {
		t.Fatal("renewed file must not be deleted")
	}

	// A stale generation can neither renew nor release.
	if err := c.Renew("f", gen+99, clock.Now().Add(time.Hour)); err != ErrGenerationMismatch {
		t.Fatalf("stale renew err = %v, want ErrGenerationMismatch", err)
	}
	if err := c.Release("f", gen+99); err != ErrGenerationMismatch {
		t.Fatalf("stale release err = %v, want ErrGenerationMismatch", err)
	}
	if !fileExists(t, dir, "f") {
		t.Fatal("stale-generation release must not delete the file")
	}
}

// An old-generation reap pass must never delete a newer file re-staged
// under the same name after the pass collected its snapshot.
func TestOldGenerationCannotDeleteNewFile(t *testing.T) {
	dir := t.TempDir()
	clock := newFakeClock()
	c, err := Open(dir, clock.Now)
	if err != nil {
		t.Fatal(err)
	}
	t0 := clock.Now()
	gen1 := mustStage(t, c, "f", "old", t0.Add(time.Minute))
	clock.Advance(2 * time.Minute) // gen1 lease expired

	// Between the reaper's snapshot and its delete, the name is
	// re-staged with a fresh lease far in the future.
	var once sync.Once
	c.beforeRevalidate = func(name string) {
		once.Do(func() {
			if _, err := c.Stage(name, []byte("new"), clock.Now().Add(time.Hour)); err != nil {
				t.Errorf("re-stage: %v", err)
			}
		})
	}
	n, err := c.ReapExpired()
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("old-generation pass reaped %d files, want 0", n)
	}
	if !fileExists(t, dir, "f") {
		t.Fatal("new-generation file deleted by old-generation pass")
	}
	data, _ := os.ReadFile(filepath.Join(dir, "f"))
	if string(data) != "new" {
		t.Fatalf("file content = %q, want %q", data, "new")
	}
	l, ok := c.Lease("f")
	if !ok || l.Generation == gen1 {
		t.Fatalf("lease = %+v (ok=%v), want new generation != %d", l, ok, gen1)
	}
}

// After a power loss (no graceful close), persisted leases survive:
// renewals made before the crash are honored, expired leases are
// reclaimed by the normal rule, and orphans from a crashed Stage are
// cleaned up. Nothing with a valid lease is ever deleted.
func TestCrashRecovery(t *testing.T) {
	dir := t.TempDir()
	clock := newFakeClock()
	c1, err := Open(dir, clock.Now)
	if err != nil {
		t.Fatal(err)
	}
	t0 := clock.Now()
	mustStage(t, c1, "keep", "K", t0.Add(time.Minute))
	mustStage(t, c1, "gone", "G", t0.Add(time.Minute))

	// Renew "keep" far out; this hits disk synchronously.
	keep, _ := c1.Lease("keep")
	if err := c1.Renew("keep", keep.Generation, t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	// Simulate a crashed Stage: file written, lease never persisted.
	if err := os.WriteFile(filepath.Join(dir, "orphan"), []byte("O"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Power loss: c1 is abandoned without any close. Clock jumps past
	// the original deadlines but not the renewed one.
	clock.Advance(10 * time.Minute)

	c2, err := Open(dir, clock.Now)
	if err != nil {
		t.Fatal(err)
	}
	if fileExists(t, dir, "orphan") {
		t.Fatal("orphan from crashed Stage must be removed during recovery")
	}
	// Recovery itself must not reap; only ReapExpired does.
	if !fileExists(t, dir, "gone") {
		t.Fatal("recovery must not delete leased files, even expired ones")
	}
	n, err := c2.ReapExpired()
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("reaped %d after recovery, want 1", n)
	}
	if fileExists(t, dir, "gone") {
		t.Fatal("expired lease must be reclaimed after recovery")
	}
	if !fileExists(t, dir, "keep") {
		t.Fatal("lease renewed before power loss must survive recovery")
	}
	if l, ok := c2.Lease("keep"); !ok || l.Generation != keep.Generation {
		t.Fatalf("recovered lease = %+v (ok=%v), want generation %d", l, ok, keep.Generation)
	}
}

// Concurrent barrier test: many holders renew continuously while the
// reaper runs flat out. No file whose lease is kept ahead of the clock
// may ever be deleted. Files whose holders stop renewing are reclaimed.
func TestConcurrentRenewReapBarrier(t *testing.T) {
	dir := t.TempDir()
	c, err := Open(dir, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	const holders = 16
	const renewFor = 200 * time.Millisecond
	const leaseHorizon = 500 * time.Millisecond
	const abandonedHorizon = 150 * time.Millisecond

	type holder struct {
		name string
		gen  uint64
	}
	holdersList := make([]holder, holders)
	for i := range holdersList {
		name := fmt.Sprintf("f%02d", i)
		horizon := leaseHorizon
		if i%2 == 1 {
			horizon = abandonedHorizon // abandoned leases expire mid-test
		}
		gen, err := c.Stage(name, []byte(name), time.Now().Add(horizon))
		if err != nil {
			t.Fatal(err)
		}
		holdersList[i] = holder{name, gen}
	}

	barrier := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, holders*2)

	// Reaper: runs continuously from the barrier until told to stop.
	stop := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-barrier
		for {
			select {
			case <-stop:
				return
			default:
				if _, err := c.ReapExpired(); err != nil {
					errs <- err
					return
				}
				time.Sleep(time.Millisecond)
			}
		}
	}()

	// Holders: all released at the barrier, renew in lockstep until the
	// window ends. The first half keep their leases alive; the second
	// half stop renewing immediately and must be reclaimed.
	wg.Add(holders)
	for i, h := range holdersList {
		go func(i int, h holder) {
			defer wg.Done()
			<-barrier
			if i%2 == 1 {
				return // let this lease expire
			}
			deadline := time.Now().Add(renewFor)
			for time.Now().Before(deadline) {
				if err := c.Renew(h.name, h.gen, time.Now().Add(leaseHorizon)); err != nil {
					errs <- fmt.Errorf("renew %s: %w", h.name, err)
					return
				}
				time.Sleep(2 * time.Millisecond)
			}
		}(i, h)
	}
	close(barrier)

	// Wait for renewers, then stop the reaper.
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	time.Sleep(renewFor + 100*time.Millisecond)
	close(stop)
	<-done
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	// Abandoned leases are now past their deadline while renewed leases
	// are still valid; a final sweep must reclaim exactly the abandoned
	// ones.
	time.Sleep(2 * abandonedHorizon)
	if _, err := c.ReapExpired(); err != nil {
		t.Fatal(err)
	}

	// No erroneous deletion: every continuously renewed file survives.
	for i, h := range holdersList {
		alive := fileExists(t, dir, h.name)
		if i%2 == 0 && !alive {
			t.Errorf("%s: renewed file was wrongly deleted", h.name)
		}
		if i%2 == 1 && alive {
			t.Errorf("%s: abandoned lease was never reclaimed", h.name)
		}
	}
}
