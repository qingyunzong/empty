package drr_test

import (
	"testing"

	"scheduler/drr"
)

func mustAdd(t *testing.T, s *drr.Scheduler, id string, w int64) {
	t.Helper()
	if err := s.AddTenant(id, w); err != nil {
		t.Fatalf("AddTenant(%q): %v", id, err)
	}
}

func mustEnqueue(t *testing.T, s *drr.Scheduler, id string, task drr.Task) {
	t.Helper()
	if err := s.Enqueue(id, task); err != nil {
		t.Fatalf("Enqueue(%q, %+v): %v", id, task, err)
	}
}

func servedFor(ledger []drr.LedgerEntry, tenant string) int64 {
	var total int64
	for _, e := range ledger {
		if e.Tenant == tenant {
			total += e.Cost
		}
	}
	return total
}

func TestNegativeCostRejected(t *testing.T) {
	s := drr.New()
	mustAdd(t, s, "a", 1)
	if err := s.Enqueue("a", drr.Task{ID: "bad", Cost: -1}); err != drr.ErrNegativeCost {
		t.Fatalf("want ErrNegativeCost, got %v", err)
	}
	if n, _ := s.QueueLen("a"); n != 0 {
		t.Fatalf("rejected task entered queue, len=%d", n)
	}
}

func TestDeficitAccumulatesWhenHeadTooExpensive(t *testing.T) {
	s := drr.New()
	mustAdd(t, s, "a", 3)
	mustEnqueue(t, s, "a", drr.Task{ID: "big", Cost: 7})

	if got := s.RunRound(); len(got) != 0 {
		t.Fatalf("round 1 should serve nothing, got %v", got)
	}
	if d, _ := s.Deficit("a"); d != 3 {
		t.Fatalf("deficit after round 1 = %d, want 3", d)
	}
	if got := s.RunRound(); len(got) != 0 {
		t.Fatalf("round 2 should serve nothing, got %v", got)
	}
	got := s.RunRound()
	if len(got) != 1 || got[0].Task != "big" || got[0].Cost != 7 {
		t.Fatalf("round 3 should serve big, got %v", got)
	}
	e := got[0]
	if e.DeficitBefore != 9 || e.DeficitAfter != 2 {
		t.Fatalf("ledger deficit = %d -> %d, want 9 -> 2", e.DeficitBefore, e.DeficitAfter)
	}
	if d, _ := s.Deficit("a"); d != 0 {
		t.Fatalf("empty queue must reset deficit, got %d", d)
	}
}

func TestEmptyQueueResetsDeficit(t *testing.T) {
	s := drr.New()
	mustAdd(t, s, "a", 10)
	mustEnqueue(t, s, "a", drr.Task{ID: "t1", Cost: 4})
	s.RunRound()
	if d, _ := s.Deficit("a"); d != 0 {
		t.Fatalf("deficit after drain = %d, want 0", d)
	}
	// No quota should accumulate while the queue is empty.
	s.Run(3)
	if d, _ := s.Deficit("a"); d != 0 {
		t.Fatalf("idle tenant accumulated deficit %d", d)
	}
	mustEnqueue(t, s, "a", drr.Task{ID: "t2", Cost: 6})
	got := s.RunRound()
	if len(got) != 1 || got[0].DeficitBefore != 10 {
		t.Fatalf("reactivated tenant should start from 0, got %+v", got)
	}
}

func TestWeightUpdateTakesEffectNextRound(t *testing.T) {
	s := drr.New()
	mustAdd(t, s, "a", 1)
	mustEnqueue(t, s, "a", drr.Task{ID: "t1", Cost: 1})
	mustEnqueue(t, s, "a", drr.Task{ID: "t2", Cost: 5})
	// Round 1 uses the initial weight: only t1 (cost 1) fits.
	got := s.RunRound()
	if len(got) != 1 || got[0].Task != "t1" || got[0].Weight != 1 {
		t.Fatalf("round 1 = %+v, want only t1 at weight 1", got)
	}
	// The update is requested after round 1 and applies from round 2 on.
	if err := s.SetWeight("a", 5); err != nil {
		t.Fatal(err)
	}
	if w, _ := s.Weight("a"); w != 1 {
		t.Fatalf("weight changed mid-stream to %d before next round", w)
	}
	// Round 2 uses the new weight: deficit 0+5 covers t2 exactly.
	got = s.RunRound()
	if len(got) != 1 || got[0].Task != "t2" || got[0].Weight != 5 {
		t.Fatalf("round 2 = %+v, want t2 at weight 5", got)
	}
}

func TestLedgerRecordsEveryDeduction(t *testing.T) {
	s := drr.New()
	mustAdd(t, s, "a", 2)
	mustAdd(t, s, "b", 1)
	mustEnqueue(t, s, "a", drr.Task{ID: "a1", Cost: 1})
	mustEnqueue(t, s, "a", drr.Task{ID: "a2", Cost: 1})
	mustEnqueue(t, s, "b", drr.Task{ID: "b1", Cost: 1})
	s.RunRound()
	ledger := s.Ledger()
	if len(ledger) != 3 {
		t.Fatalf("ledger len = %d, want 3", len(ledger))
	}
	for i, e := range ledger {
		if e.Round != 1 {
			t.Fatalf("entry %d round = %d, want 1", i, e.Round)
		}
		if e.DeficitBefore-e.Cost != e.DeficitAfter {
			t.Fatalf("entry %d inconsistent: %+v", i, e)
		}
	}
	if ledger[0].Tenant != "a" || ledger[1].Tenant != "a" || ledger[2].Tenant != "b" {
		t.Fatalf("round-robin order broken: %+v", ledger)
	}
}

func TestErrors(t *testing.T) {
	s := drr.New()
	if err := s.AddTenant("a", 0); err != drr.ErrInvalidWeight {
		t.Fatalf("zero weight: %v", err)
	}
	mustAdd(t, s, "a", 1)
	if err := s.AddTenant("a", 1); err != drr.ErrTenantExists {
		t.Fatalf("duplicate tenant: %v", err)
	}
	if err := s.Enqueue("ghost", drr.Task{ID: "x", Cost: 1}); err != drr.ErrUnknownTenant {
		t.Fatalf("enqueue unknown: %v", err)
	}
	if err := s.SetWeight("ghost", 1); err != drr.ErrUnknownTenant {
		t.Fatalf("setweight unknown: %v", err)
	}
	if err := s.SetWeight("a", -2); err != drr.ErrInvalidWeight {
		t.Fatalf("negative weight: %v", err)
	}
}

// TestLargeTaskDoesNotStarve pins a tenant behind one huge head task while
// other tenants stream cheap tasks; the huge task must still be served.
func TestLargeTaskDoesNotStarve(t *testing.T) {
	s := drr.New()
	mustAdd(t, s, "heavy", 1)
	mustAdd(t, s, "light", 1)
	mustEnqueue(t, s, "heavy", drr.Task{ID: "whale", Cost: 500})
	for i := 0; i < 600; i++ {
		mustEnqueue(t, s, "light", drr.Task{ID: "fish", Cost: 1})
	}
	served := false
	for r := 0; r < 600 && !served; r++ {
		for _, e := range s.RunRound() {
			if e.Task == "whale" {
				served = true
			}
		}
	}
	if !served {
		t.Fatal("huge head task starved: never served within 600 rounds")
	}
}

// TestFairShareBounds checks the classic DRR guarantee: over a long run the
// work served to backlogged tenants tracks their weight ratio.
func TestFairShareBounds(t *testing.T) {
	s := drr.New()
	mustAdd(t, s, "a", 1)
	mustAdd(t, s, "b", 3)
	for i := 0; i < 4000; i++ {
		mustEnqueue(t, s, "a", drr.Task{ID: "a", Cost: 1})
		mustEnqueue(t, s, "b", drr.Task{ID: "b", Cost: 1})
	}
	s.Run(1000)
	ledger := s.Ledger()
	sa, sb := servedFor(ledger, "a"), servedFor(ledger, "b")
	if sa == 0 || sb == 0 {
		t.Fatalf("tenant starved: a=%d b=%d", sa, sb)
	}
	ratio := float64(sb) / float64(sa)
	if ratio < 2.5 || ratio > 3.5 {
		t.Fatalf("served ratio b/a = %.2f, want ~3 (a=%d b=%d)", ratio, sa, sb)
	}
}
