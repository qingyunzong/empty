package txstore

import (
	"errors"
	"fmt"
	"testing"
)

// commitCrashPoints enumerates every durability boundary in the
// Prepare+Commit flow for a transaction touching partitions 0, 1 and 2.
var commitCrashPoints = []string{
	"begin",     // before any prepare record
	"prepare-0", // partition 0 prepare durable
	"prepare-1", // partition 1 prepare durable
	"prepare-2", // partition 2 prepare durable
	"decision",  // cross-partition decision durable (commit point)
	"apply-0",   // partition 0 commit record durable
	"apply-1",   // partition 1 commit record durable
	"apply-2",   // partition 2 commit record durable
}

// TestFaultExhaustiveCommit crashes the store at every durability boundary
// of the commit protocol, recovers, and verifies the atomic-visibility
// invariant: the transaction is either fully committed everywhere or not
// visible anywhere, always consistent with the durable decision log.
func TestFaultExhaustiveCommit(t *testing.T) {
	const nparts = 3
	keys := []string{keyForPartition(nparts, 0), keyForPartition(nparts, 1), keyForPartition(nparts, 2)}
	for _, point := range commitCrashPoints {
		t.Run("crash@"+point, func(t *testing.T) {
			dir := t.TempDir()
			s, err := Open(dir, nparts)
			if err != nil {
				t.Fatal(err)
			}
			tx := Txn{ID: "tx", Reads: keys, Writes: map[string]string{
				keys[0]: "v0", keys[1]: "v1", keys[2]: "v2",
			}}
			s.hook = crashAt(point)
			_, crashed := runCatching(func() error {
				if err := s.Prepare(tx); err != nil {
					return fmt.Errorf("prepare: %w", err)
				}
				if err := s.Commit(tx.ID); err != nil {
					return fmt.Errorf("commit: %w", err)
				}
				return nil
			})
			if !crashed {
				t.Fatalf("no crash happened; hook point %q never fired", point)
			}
			if _, err := s.Get(keys[0]); !errors.Is(err, ErrCrashed) {
				t.Fatalf("dead store Get = %v; want ErrCrashed", err)
			}

			// Recover from the same directory.
			s2, err := Open(dir, nparts)
			if err != nil {
				t.Fatalf("recover: %v", err)
			}
			defer s2.Close()

			dec := durableDecision(t, dir, "tx")
			visible := 0
			for i, k := range keys {
				got, err := s2.Get(k)
				switch {
				case err == nil:
					visible++
					if want := fmt.Sprintf("v%d", i); got != want {
						t.Fatalf("Get(%q) = %q; want %q", k, got, want)
					}
				case errors.Is(err, ErrNotFound):
				case errors.Is(err, ErrPending):
					t.Fatalf("Get(%q) = ErrPending after completed recovery", k)
				default:
					t.Fatalf("Get(%q) = %v", k, err)
				}
			}
			// All-or-nothing, consistent with the durable decision. (For
			// crashes before the commit point, recovery itself persists an
			// abort decision, so "abort" is the expected post-recovery
			// record there.)
			switch dec {
			case decideCommit:
				if visible != len(keys) {
					t.Fatalf("durable commit but only %d/%d writes visible", visible, len(keys))
				}
			case decideAbort, "":
				if visible != 0 {
					t.Fatalf("durable %q but %d/%d writes visible", dec, visible, len(keys))
				}
			default:
				t.Fatalf("unexpected durable decision %q", dec)
			}
		})
	}
}

// TestFaultExhaustiveAbort crashes the store at every durability boundary of
// the abort flow and verifies that nothing ever becomes visible and no lock
// survives recovery.
func TestFaultExhaustiveAbort(t *testing.T) {
	const nparts = 3
	keys := []string{keyForPartition(nparts, 0), keyForPartition(nparts, 1), keyForPartition(nparts, 2)}
	abortCrashPoints := []string{"decision", "apply-0", "apply-1", "apply-2"}
	for _, point := range abortCrashPoints {
		t.Run("crash@"+point, func(t *testing.T) {
			dir := t.TempDir()
			s, err := Open(dir, nparts)
			if err != nil {
				t.Fatal(err)
			}
			tx := Txn{ID: "tx", Writes: map[string]string{
				keys[0]: "v0", keys[1]: "v1", keys[2]: "v2",
			}}
			if err := s.Prepare(tx); err != nil {
				t.Fatalf("prepare: %v", err)
			}
			s.hook = crashAt(point)
			_, crashed := runCatching(func() error { return s.Abort(tx.ID) })
			if !crashed {
				t.Fatalf("no crash happened; hook point %q never fired", point)
			}

			s2, err := Open(dir, nparts)
			if err != nil {
				t.Fatalf("recover: %v", err)
			}
			defer s2.Close()
			if dec := durableDecision(t, dir, "tx"); dec != decideAbort {
				t.Fatalf("durable decision = %q; want abort", dec)
			}
			for _, k := range keys {
				if _, err := s2.Get(k); !errors.Is(err, ErrNotFound) {
					t.Fatalf("Get(%q) = %v; want ErrNotFound (aborted, lock released)", k, err)
				}
			}
		})
	}
}

// TestFaultDecisionIsFinal: once the commit decision is durable, no amount
// of crashing during the apply phase can turn the transaction into an abort
// — recovery must keep replaying the commit until it is fully visible.
func TestFaultDecisionIsFinal(t *testing.T) {
	const nparts = 3
	keys := []string{keyForPartition(nparts, 0), keyForPartition(nparts, 1), keyForPartition(nparts, 2)}
	dir := t.TempDir()

	// First attempt commits and crashes mid-apply; the reopen must replay
	// the durable commit to completion.
	for attempt := 0; ; attempt++ {
		s, err := Open(dir, nparts)
		if err != nil {
			t.Fatal(err)
		}
		if attempt == 0 {
			tx := Txn{ID: "tx", Writes: map[string]string{
				keys[0]: "v0", keys[1]: "v1", keys[2]: "v2",
			}}
			if err := s.Prepare(tx); err != nil {
				t.Fatalf("prepare: %v", err)
			}
			s.hook = crashAt("apply-0")
			_, crashed := runCatching(func() error { return s.Commit("tx") })
			if !crashed {
				t.Fatal("expected crash during initial commit")
			}
			continue
		}
		// Recovery replays the durable commit. It finishes fully inside
		// Open, so by now every key must be visible.
		for i, k := range keys {
			got, err := s.Get(k)
			if err != nil || got != fmt.Sprintf("v%d", i) {
				t.Fatalf("attempt %d: Get(%q) = %q, %v", attempt, k, got, err)
			}
		}
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
		break
	}
}
