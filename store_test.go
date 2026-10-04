package quota

import (
	"errors"
	"sync"
	"testing"
)

func TestAliasMergeChargesOldAliasToNewRoot(t *testing.T) {
	s := NewStore()
	s.SetLimit("old", 100)
	s.SetLimit("new", 50)
	if err := s.Consume("old", 40); err != nil {
		t.Fatal(err)
	}
	merged, err := s.AddAlias("old", "new")
	if err != nil || !merged {
		t.Fatalf("merge: merged=%v err=%v", merged, err)
	}
	if got := s.Resolve("old"); got != s.Resolve("new") {
		t.Fatalf("old resolves to %q, new to %q", got, s.Resolve("new"))
	}
	// A request addressed to the old alias is charged along to the new root.
	if err := s.Consume("old", 60); err != nil {
		t.Fatal(err)
	}
	root, limit, used, leased := s.Snapshot("new")
	if limit != 150 || used != 100 || leased != 0 {
		t.Fatalf("root %q: limit=%d used=%d leased=%d, want 150/100/0", root, limit, used, leased)
	}
	if _, _, used2, _ := s.Snapshot("old"); used2 != 100 {
		t.Fatalf("old alias sees used=%d, want 100", used2)
	}
	if err := s.VerifyConservation(); err != nil {
		t.Fatal(err)
	}
}

func TestCycleReport(t *testing.T) {
	s := NewStore()
	if _, err := s.AddAlias("a", "b"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddAlias("b", "c"); err != nil {
		t.Fatal(err)
	}
	merged, err := s.AddAlias("c", "a")
	if err == nil || merged {
		t.Fatalf("expected cycle rejection, got merged=%v err=%v", merged, err)
	}
	cycles := s.Cycles()
	if len(cycles) != 1 || cycles[0] != (Cycle{A: "c", B: "a"}) {
		t.Fatalf("cycles=%v, want [{c a}]", cycles)
	}
	// The rejected edge must not have disturbed the component.
	if got := s.Members("a"); len(got) != 3 {
		t.Fatalf("members=%v, want 3 members", got)
	}
}

func TestMergeCombinesBalancesAndLeases(t *testing.T) {
	s := NewStore()
	s.SetLimit("a", 100)
	s.SetLimit("b", 200)
	if err := s.Consume("a", 10); err != nil {
		t.Fatal(err)
	}
	if err := s.AcquireLease("b", "L1", 50); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddAlias("a", "b"); err != nil {
		t.Fatal(err)
	}
	_, limit, used, leased := s.Snapshot("a")
	if limit != 300 || used != 10 || leased != 50 {
		t.Fatalf("limit=%d used=%d leased=%d, want 300/10/50", limit, used, leased)
	}
	// Lease acquired under the old name is releasable through the alias.
	if err := s.ReleaseLease("a", "L1"); err != nil {
		t.Fatal(err)
	}
	if _, _, _, leased := s.Snapshot("b"); leased != 0 {
		t.Fatalf("leased=%d, want 0", leased)
	}
}

func TestLimitExceeded(t *testing.T) {
	s := NewStore()
	s.SetLimit("a", 10)
	if err := s.Consume("a", 11); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("err=%v, want ErrLimitExceeded", err)
	}
	if err := s.AcquireLease("a", "L", 6); err != nil {
		t.Fatal(err)
	}
	if err := s.Consume("a", 5); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("err=%v, want ErrLimitExceeded (lease holds 6 of 10)", err)
	}
	if err := s.VerifyConservation(); err != nil {
		t.Fatal(err)
	}
}

func TestSplitRequiresNoActiveLeases(t *testing.T) {
	s := NewStore()
	s.SetLimit("a", 100)
	s.SetLimit("b", 100)
	if _, err := s.AddAlias("a", "b"); err != nil {
		t.Fatal(err)
	}
	if err := s.AcquireLease("a", "L1", 10); err != nil {
		t.Fatal(err)
	}
	if err := s.Split("a", "b"); !errors.Is(err, ErrActiveLeases) {
		t.Fatalf("err=%v, want ErrActiveLeases", err)
	}
	if err := s.ReleaseLease("b", "L1"); err != nil {
		t.Fatal(err)
	}
	if err := s.Split("a", "b"); err != nil {
		t.Fatal(err)
	}
	if s.Resolve("a") == s.Resolve("b") {
		t.Fatal("a and b still resolve to the same root after split")
	}
	if _, limit, _, _ := s.Snapshot("a"); limit != 100 {
		t.Fatalf("a limit=%d, want 100", limit)
	}
	if _, limit, _, _ := s.Snapshot("b"); limit != 100 {
		t.Fatalf("b limit=%d, want 100", limit)
	}
	if err := s.VerifyConservation(); err != nil {
		t.Fatal(err)
	}
}

func TestSplitPartitionsSharesExactly(t *testing.T) {
	s := NewStore()
	s.SetLimit("a", 10)
	s.SetLimit("b", 20)
	s.SetLimit("c", 40)
	if _, err := s.AddAlias("a", "b"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddAlias("b", "c"); err != nil {
		t.Fatal(err)
	}
	if err := s.Consume("c", 15); err != nil {
		t.Fatal(err)
	}
	// Remove the middle edge: {a} separates from {b, c}.
	if err := s.Split("a", "b"); err != nil {
		t.Fatal(err)
	}
	if _, limit, used, _ := s.Snapshot("a"); limit != 10 || used != 0 {
		t.Fatalf("a: limit=%d used=%d, want 10/0", limit, used)
	}
	if _, limit, used, _ := s.Snapshot("c"); limit != 60 || used != 15 {
		t.Fatalf("bc: limit=%d used=%d, want 60/15", limit, used)
	}
	if s.Resolve("b") != s.Resolve("c") {
		t.Fatal("b and c should still share a root")
	}
	if err := s.VerifyConservation(); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentMergeAndConsumeIsAtomic(t *testing.T) {
	s := NewStore()
	const n = 64
	for i := 0; i < n; i++ {
		s.SetLimit(name(byte('A'+i%26), i), 1000)
	}
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		i := i
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _ = s.AddAlias(name(byte('A'+i%26), i), name(byte('A'+(i+1)%26), (i+1)%n))
		}()
		go func() {
			defer wg.Done()
			_ = s.Consume(name(byte('A'+i%26), i), 7)
		}()
	}
	wg.Wait()
	// Whatever the interleaving, no quota may have been created or lost.
	if err := s.VerifyConservation(); err != nil {
		t.Fatal(err)
	}
}

func name(prefix byte, i int) string {
	return string([]byte{prefix}) + "-" + string(rune('0'+i%10)) + string(rune('0'+i/10))
}
