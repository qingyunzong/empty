package idem_test

import (
	"errors"
	"fmt"
	"maps"
	"sync"
	"testing"

	"idem"
)

// ledger is the business state used throughout the tests.
type ledger struct {
	balances map[string]int64
}

func newLedger() ledger {
	return ledger{balances: map[string]int64{"alice": 100, "bob": 0}}
}

var errInsufficient = errors.New("insufficient funds")

// transfer is a copy-on-write business Op: it returns the next ledger
// without mutating the input, so the store can commit it atomically.
func transfer(from, to string, amount int64) idem.Op[ledger, string] {
	return func(l ledger) (ledger, string, error) {
		if l.balances[from] < amount {
			return l, "", errInsufficient
		}
		next := ledger{balances: maps.Clone(l.balances)}
		next.balances[from] -= amount
		next.balances[to] += amount
		return next, fmt.Sprintf("moved %d from %s to %s", amount, from, to), nil
	}
}

func key(seq uint64) idem.Key { return idem.Key{ClientID: "c1", Generation: 1, Seq: seq} }

func TestDuplicateReturnsOriginalDecision(t *testing.T) {
	s := idem.New[ledger, string](newLedger())

	r1, err := s.Execute(key(1), transfer("alice", "bob", 30))
	if err != nil || r1.Decision != idem.Executed {
		t.Fatalf("first execute: decision=%v err=%v", r1.Decision, err)
	}

	r2, err := s.Execute(key(1), transfer("alice", "bob", 30))
	if err != nil || r2.Decision != idem.Duplicate {
		t.Fatalf("duplicate execute: decision=%v err=%v", r2.Decision, err)
	}
	if r2.Value != r1.Value {
		t.Fatalf("duplicate replayed different value: %q vs %q", r2.Value, r1.Value)
	}
	if got := s.State().balances; got["alice"] != 70 || got["bob"] != 30 {
		t.Fatalf("business op ran twice: balances=%v", got)
	}

	// A business rejection is also a cached decision and must be replayed.
	r3, err := s.Execute(key(2), transfer("alice", "bob", 500))
	if err != nil || r3.Decision != idem.Executed || !errors.Is(r3.Verdict, errInsufficient) {
		t.Fatalf("rejected execute: decision=%v verdict=%v err=%v", r3.Decision, r3.Verdict, err)
	}
	r4, err := s.Execute(key(2), transfer("alice", "bob", 500))
	if err != nil || r4.Decision != idem.Duplicate || !errors.Is(r4.Verdict, errInsufficient) {
		t.Fatalf("rejected duplicate: decision=%v verdict=%v err=%v", r4.Decision, r4.Verdict, err)
	}
	if got := s.State().balances; got["alice"] != 70 || got["bob"] != 30 {
		t.Fatalf("rejected op changed state: balances=%v", got)
	}
}

func TestBelowWatermarkReturnsReclaimedNotReexecuted(t *testing.T) {
	s := idem.New[ledger, string](newLedger())
	for seq := uint64(1); seq <= 3; seq++ {
		if _, err := s.Execute(key(seq), transfer("alice", "bob", 10)); err != nil {
			t.Fatalf("execute seq %d: %v", seq, err)
		}
	}
	if err := s.Ack("c1", 1, 3); err != nil {
		t.Fatalf("ack: %v", err)
	}

	r, err := s.Execute(key(2), transfer("alice", "bob", 10))
	if err != nil || r.Decision != idem.Reclaimed {
		t.Fatalf("below-watermark execute: decision=%v err=%v", r.Decision, err)
	}
	if got := s.State().balances; got["alice"] != 70 || got["bob"] != 30 {
		t.Fatalf("reclaimed key was re-executed: balances=%v", got)
	}

	// Keys above the watermark still execute normally.
	r, err = s.Execute(key(4), transfer("alice", "bob", 10))
	if err != nil || r.Decision != idem.Executed {
		t.Fatalf("above-watermark execute: decision=%v err=%v", r.Decision, err)
	}
}

func TestWatermarkAdvancesOnlyOnClientAck(t *testing.T) {
	s := idem.New[ledger, string](newLedger())
	for seq := uint64(1); seq <= 2; seq++ {
		if _, err := s.Execute(key(seq), transfer("alice", "bob", 10)); err != nil {
			t.Fatalf("execute seq %d: %v", seq, err)
		}
	}

	// Execution alone must not move the watermark.
	if wm := s.Watermark("c1", 1); wm != 0 {
		t.Fatalf("watermark moved without ack: %d", wm)
	}
	r, _ := s.Execute(key(1), transfer("alice", "bob", 10))
	if r.Decision != idem.Duplicate {
		t.Fatalf("un-acked key should replay from cache, got %v", r.Decision)
	}

	if err := s.Ack("c1", 1, 1); err != nil {
		t.Fatalf("ack: %v", err)
	}
	if wm := s.Watermark("c1", 1); wm != 1 {
		t.Fatalf("watermark after ack: %d", wm)
	}
	r, _ = s.Execute(key(1), transfer("alice", "bob", 10))
	if r.Decision != idem.Reclaimed {
		t.Fatalf("acked key should be reclaimed, got %v", r.Decision)
	}

	// Acks are idempotent and monotonic.
	if err := s.Ack("c1", 1, 1); err != nil {
		t.Fatalf("repeat ack: %v", err)
	}
	if wm := s.Watermark("c1", 1); wm != 1 {
		t.Fatalf("watermark regressed: %d", wm)
	}

	// Ack beyond the highest executed sequence is rejected.
	if err := s.Ack("c1", 1, 5); !errors.Is(err, idem.ErrAckBeyondExecuted) {
		t.Fatalf("ack beyond executed: %v", err)
	}
	if wm := s.Watermark("c1", 1); wm != 1 {
		t.Fatalf("watermark moved by invalid ack: %d", wm)
	}
}

var errCrash = errors.New("simulated crash")

func crashAt(target idem.CrashPoint) func(idem.CrashPoint) error {
	return func(p idem.CrashPoint) error {
		if p == target {
			return errCrash
		}
		return nil
	}
}

func TestCrashBetweenCacheAndBusinessCommitIsAtomic(t *testing.T) {
	t.Run("crash between cache and commit applies nothing", func(t *testing.T) {
		s := idem.New[ledger, string](newLedger())
		s.SetCrashHook(crashAt(idem.CrashBetweenCacheAndCommit))

		if _, err := s.Execute(key(1), transfer("alice", "bob", 30)); !errors.Is(err, errCrash) {
			t.Fatalf("expected crash, got %v", err)
		}
		if got := s.State().balances; got["alice"] != 100 || got["bob"] != 0 {
			t.Fatalf("partial business commit after crash: balances=%v", got)
		}

		// After "restart" (hook cleared) the same key must execute cleanly:
		// no cache record survived, so this is Executed, not Duplicate, and
		// the transfer happens exactly once.
		s.SetCrashHook(nil)
		r, err := s.Execute(key(1), transfer("alice", "bob", 30))
		if err != nil || r.Decision != idem.Executed {
			t.Fatalf("retry after crash: decision=%v err=%v", r.Decision, err)
		}
		if got := s.State().balances; got["alice"] != 70 || got["bob"] != 30 {
			t.Fatalf("transfer applied wrong number of times: balances=%v", got)
		}
	})

	t.Run("crash before cache write applies nothing", func(t *testing.T) {
		s := idem.New[ledger, string](newLedger())
		s.SetCrashHook(crashAt(idem.CrashBeforeCacheWrite))

		if _, err := s.Execute(key(1), transfer("alice", "bob", 30)); !errors.Is(err, errCrash) {
			t.Fatalf("expected crash, got %v", err)
		}
		if got := s.State().balances; got["alice"] != 100 || got["bob"] != 0 {
			t.Fatalf("state changed before cache write: balances=%v", got)
		}
		s.SetCrashHook(nil)
		r, _ := s.Execute(key(1), transfer("alice", "bob", 30))
		if r.Decision != idem.Executed {
			t.Fatalf("retry after crash: decision=%v", r.Decision)
		}
	})

	t.Run("crash after commit applies both", func(t *testing.T) {
		s := idem.New[ledger, string](newLedger())
		s.SetCrashHook(crashAt(idem.CrashAfterCommit))

		if _, err := s.Execute(key(1), transfer("alice", "bob", 30)); !errors.Is(err, errCrash) {
			t.Fatalf("expected crash, got %v", err)
		}
		if got := s.State().balances; got["alice"] != 70 || got["bob"] != 30 {
			t.Fatalf("commit not atomic after crash: balances=%v", got)
		}

		// The cache record survived with the business effect: the retry is a
		// Duplicate replay, never a re-execution.
		s.SetCrashHook(nil)
		r, err := s.Execute(key(1), transfer("alice", "bob", 30))
		if err != nil || r.Decision != idem.Duplicate {
			t.Fatalf("retry after post-commit crash: decision=%v err=%v", r.Decision, err)
		}
		if got := s.State().balances; got["alice"] != 70 || got["bob"] != 30 {
			t.Fatalf("transfer re-executed after crash: balances=%v", got)
		}
	})
}

func TestStaleGenerationIsReclaimed(t *testing.T) {
	s := idem.New[ledger, string](newLedger())

	r, err := s.Execute(idem.Key{ClientID: "c1", Generation: 2, Seq: 1}, transfer("alice", "bob", 10))
	if err != nil || r.Decision != idem.Executed {
		t.Fatalf("gen 2 execute: decision=%v err=%v", r.Decision, err)
	}

	// A request from an older generation is never re-executed.
	r, err = s.Execute(idem.Key{ClientID: "c1", Generation: 1, Seq: 9}, transfer("alice", "bob", 10))
	if err != nil || r.Decision != idem.Reclaimed {
		t.Fatalf("stale generation: decision=%v err=%v", r.Decision, err)
	}
	if got := s.State().balances; got["alice"] != 90 || got["bob"] != 10 {
		t.Fatalf("stale generation re-executed: balances=%v", got)
	}

	if err := s.Ack("c1", 1, 1); !errors.Is(err, idem.ErrStaleGeneration) {
		t.Fatalf("ack stale generation: %v", err)
	}
}

func TestConcurrentSameKeyExecutesOnce(t *testing.T) {
	s := idem.New[ledger, string](newLedger())

	const workers = 32
	decisions := make(chan idem.Decision, workers)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := s.Execute(key(1), transfer("alice", "bob", 30))
			if err != nil {
				t.Errorf("execute: %v", err)
				return
			}
			decisions <- r.Decision
		}()
	}
	wg.Wait()
	close(decisions)

	executed, duplicates := 0, 0
	for d := range decisions {
		switch d {
		case idem.Executed:
			executed++
		case idem.Duplicate:
			duplicates++
		default:
			t.Errorf("unexpected decision %v", d)
		}
	}
	if executed != 1 || duplicates != workers-1 {
		t.Fatalf("executed=%d duplicates=%d, want 1 and %d", executed, duplicates, workers-1)
	}
	if got := s.State().balances; got["alice"] != 70 || got["bob"] != 30 {
		t.Fatalf("transfer applied more than once: balances=%v", got)
	}
}
