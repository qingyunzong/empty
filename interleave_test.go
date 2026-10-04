package ownership_test

import (
	"errors"
	"testing"
	"time"

	"ownership"
)

// step is one atomic operation in a goroutine's program.
type step struct {
	name string
	run  func(*env) error
}

// env is the shared world the concurrent programs observe and mutate.
type env struct {
	reg     *ownership.Registry
	clock   *ownership.ManualClock
	ticket  ownership.Ticket // alice's generation-1 ticket
	id      uint64           // last transfer ID a prepare produced
	removed bool             // a remove has succeeded
	renewed bool             // the name was re-registered after removal
}

func newEnv(ttl time.Duration) *env {
	clock := ownership.NewManualClock(time.Unix(1_700_000_000, 0))
	reg := ownership.NewWithClock(ttl, clock)
	ticket, err := reg.Register("res", "alice")
	if err != nil {
		panic(err)
	}
	return &env{reg: reg, clock: clock, ticket: ticket}
}

// eachInterleaving enumerates every interleaving of the given per-goroutine
// programs (order within each program preserved) and calls fn with each one.
func eachInterleaving(programs [][]step, fn func(path []step)) {
	pos := make([]int, len(programs))
	var path []step
	var walk func()
	walk = func() {
		progressed := false
		for g := range programs {
			if pos[g] < len(programs[g]) {
				progressed = true
				pos[g]++
				path = append(path, programs[g][pos[g]-1])
				walk()
				path = path[:len(path)-1]
				pos[g]--
			}
		}
		if !progressed {
			fn(path)
		}
	}
	walk()
}

// TestInterleavingsExactlyOneOwner races a holder (prepare, withdraw), the
// designated recipient (confirm), an attacker forging a ticket generation,
// and the clock (advancing past the transfer TTL). For every one of the
// 180 interleavings it replays the trace from a fresh registry and asserts
// after every atomic step that the resource has exactly one owner, that
// ownership moves only through a successful in-time confirm, and that
// forged tickets never succeed.
func TestInterleavingsExactlyOneOwner(t *testing.T) {
	const ttl = time.Minute

	programs := [][]step{
		{ // alice, the current holder
			{"prepare", func(e *env) error {
				id, err := e.reg.Prepare(e.ticket, "bob")
				if err == nil {
					e.id = id
				}
				return err
			}},
			{"withdraw", func(e *env) error {
				return e.reg.Withdraw("res", e.id)
			}},
		},
		{ // bob, the designated recipient
			{"confirm", func(e *env) error {
				return e.reg.Confirm("res", e.id)
			}},
		},
		{ // carol, forging a ticket generation she never observed
			{"evil-prepare", func(e *env) error {
				forged := ownership.Ticket{Name: "res", Generation: e.ticket.Generation + 7}
				_, err := e.reg.Prepare(forged, "carol")
				return err
			}},
			{"evil-remove", func(e *env) error {
				forged := ownership.Ticket{Name: "res", Generation: e.ticket.Generation + 7}
				return e.reg.Remove(forged)
			}},
		},
		{ // the clock, jumping past the transfer deadline
			{"tick", func(e *env) error {
				e.clock.Advance(2 * ttl)
				return nil
			}},
		},
	}

	var interleavings, confirmed, kept int
	eachInterleaving(programs, func(path []step) {
		interleavings++
		e := newEnv(ttl)
		last := "alice"
		for _, s := range path {
			err := s.run(e)

			owner, _, ok := e.reg.Owner("res")
			if !ok {
				t.Fatalf("after %q: resource vanished", s.name)
			}
			if owner != "alice" && owner != "bob" {
				t.Fatalf("after %q: unexpected owner %q", s.name, owner)
			}

			switch s.name {
			case "confirm":
				if err == nil {
					if last != "alice" || owner != "bob" {
						t.Fatalf("confirm moved %q -> %q, want alice -> bob", last, owner)
					}
				} else if owner != last {
					t.Fatalf("failed confirm changed owner %q -> %q", last, owner)
				}
			case "evil-prepare", "evil-remove":
				if err == nil {
					t.Fatalf("%q succeeded with a forged ticket", s.name)
				}
				if owner != last {
					t.Fatalf("%q changed owner %q -> %q", s.name, last, owner)
				}
			default: // prepare, withdraw, tick never move ownership
				if owner != last {
					t.Fatalf("%q changed owner %q -> %q", s.name, last, owner)
				}
			}
			last = owner
		}
		if last == "bob" {
			confirmed++
		} else {
			kept++
		}
	})

	if interleavings != 180 {
		t.Fatalf("explored %d interleavings, want 180", interleavings)
	}
	if confirmed == 0 {
		t.Fatal("no interleaving completed the transfer to bob")
	}
	if kept == 0 {
		t.Fatal("no interleaving kept ownership with alice (timeout/withdraw path)")
	}
	t.Logf("explored %d interleavings: %d confirmed to bob, %d kept by alice", interleavings, confirmed, kept)
}

// TestInterleavingsNameReuse races remove+re-register of a name against an
// actor replaying the previous generation's ticket, and proves the stale
// ticket is always rejected once the name has been reused.
func TestInterleavingsNameReuse(t *testing.T) {
	const ttl = time.Minute

	programs := [][]step{
		{ // alice retires the name and dave re-registers it
			{"remove", func(e *env) error {
				err := e.reg.Remove(e.ticket)
				if err == nil {
					e.removed = true
				}
				return err
			}},
			{"register", func(e *env) error {
				_, err := e.reg.Register("res", "dave")
				if err == nil {
					e.renewed = true
				}
				return err
			}},
		},
		{ // carol replays alice's generation-1 ticket
			{"reuse-prepare", func(e *env) error {
				id, err := e.reg.Prepare(e.ticket, "carol")
				if err == nil {
					e.id = id
				}
				return err
			}},
			{"reuse-confirm", func(e *env) error {
				return e.reg.Confirm("res", e.id)
			}},
		},
		{ // the clock
			{"tick", func(e *env) error {
				e.clock.Advance(2 * ttl)
				return nil
			}},
		},
	}

	var interleavings, staleRejected, daveOwned int
	eachInterleaving(programs, func(path []step) {
		interleavings++
		e := newEnv(ttl)
		last := "alice"
		exists := true
		for _, s := range path {
			err := s.run(e)

			owner, _, ok := e.reg.Owner("res")
			if ok != exists {
				// Existence may only flip via remove (gone) or register (back).
				if exists && !(s.name == "remove" && err == nil) {
					t.Fatalf("after %q: resource unexpectedly gone", s.name)
				}
				if !exists && !(s.name == "register" && err == nil) {
					t.Fatalf("after %q: resource unexpectedly back", s.name)
				}
			}
			if ok {
				if exists && owner != last {
					// While the resource lives, only a successful confirm
					// may move ownership.
					if s.name != "reuse-confirm" || err != nil {
						t.Fatalf("after %q: owner moved %q -> %q without confirm", s.name, last, owner)
					}
				}
				last = owner
			}
			exists = ok

			// Once the name was reused, the old generation is stale forever.
			if s.name == "reuse-prepare" {
				if e.renewed && !errors.Is(err, ownership.ErrStaleTicket) {
					t.Fatalf("stale-ticket prepare after name reuse = %v, want ErrStaleTicket", err)
				}
				if err == nil && e.removed {
					t.Fatal("stale-ticket prepare succeeded after name reuse")
				}
			}
		}
		if e.renewed {
			staleRejected++
		}
		if last == "dave" && exists {
			daveOwned++
		}
	})

	if interleavings != 30 {
		t.Fatalf("explored %d interleavings, want 30", interleavings)
	}
	if staleRejected == 0 || daveOwned == 0 {
		t.Fatalf("coverage missing: staleRejected=%d daveOwned=%d", staleRejected, daveOwned)
	}
	t.Logf("explored %d interleavings: %d ended with dave owning the reused name", interleavings, daveOwned)
}
