package drr_test

import (
	"errors"
	"testing"

	"drr"
)

func newScheduler(t *testing.T, quantum int) *drr.Scheduler {
	t.Helper()
	s, err := drr.New(quantum)
	if err != nil {
		t.Fatalf("New(%d): %v", quantum, err)
	}
	return s
}

func mustAddTenant(t *testing.T, s *drr.Scheduler, id string, weight int) {
	t.Helper()
	if err := s.AddTenant(id, weight); err != nil {
		t.Fatalf("AddTenant(%q, %d): %v", id, weight, err)
	}
}

func mustEnqueue(t *testing.T, s *drr.Scheduler, tenantID string, task drr.Task) {
	t.Helper()
	if err := s.Enqueue(tenantID, task); err != nil {
		t.Fatalf("Enqueue(%q, %+v): %v", tenantID, task, err)
	}
}

func TestNegativeCostRejected(t *testing.T) {
	s := newScheduler(t, 10)
	mustAddTenant(t, s, "a", 1)

	err := s.Enqueue("a", drr.Task{ID: "bad", Cost: -1})
	if !errors.Is(err, drr.ErrNegativeCost) {
		t.Fatalf("expected ErrNegativeCost, got %v", err)
	}
	if got := s.Backlog("a"); got != 0 {
		t.Fatalf("rejected task entered queue, backlog = %d", got)
	}
	if err := s.Enqueue("a", drr.Task{ID: "zero", Cost: 0}); err != nil {
		t.Fatalf("zero cost should be accepted: %v", err)
	}
}

func TestInvalidArguments(t *testing.T) {
	if _, err := drr.New(0); err == nil {
		t.Fatal("New(0) should fail")
	}
	s := newScheduler(t, 10)
	if err := s.AddTenant("a", 0); err == nil {
		t.Fatal("zero weight should fail")
	}
	mustAddTenant(t, s, "a", 1)
	if err := s.AddTenant("a", 2); err == nil {
		t.Fatal("duplicate tenant should fail")
	}
	if err := s.SetWeight("ghost", 1); err == nil {
		t.Fatal("SetWeight on unknown tenant should fail")
	}
	if err := s.Enqueue("ghost", drr.Task{ID: "x", Cost: 1}); err == nil {
		t.Fatal("Enqueue on unknown tenant should fail")
	}
}

func TestDeficitAccumulatesAcrossRounds(t *testing.T) {
	s := newScheduler(t, 10)
	mustAddTenant(t, s, "a", 1)
	mustEnqueue(t, s, "a", drr.Task{ID: "big", Cost: 25})

	if got := s.RunRound(); len(got) != 0 {
		t.Fatalf("round 1 should not serve, got %v", got)
	}
	if got := s.RunRound(); len(got) != 0 {
		t.Fatalf("round 2 should not serve (deficit 20 < 25), got %v", got)
	}
	got := s.RunRound()
	if len(got) != 1 || got[0] != (drr.LedgerEntry{Round: 3, TenantID: "a", TaskID: "big", Cost: 25}) {
		t.Fatalf("round 3 should serve big task, got %v", got)
	}
	if d, _ := s.Deficit("a"); d != 0 {
		t.Fatalf("queue emptied, deficit should reset to 0, got %d", d)
	}
}

func TestEmptyQueueResetsDeficit(t *testing.T) {
	s := newScheduler(t, 10)
	mustAddTenant(t, s, "a", 1)
	mustEnqueue(t, s, "a", drr.Task{ID: "small", Cost: 3})

	s.RunRound() // 服务 small，剩余赤字 7，队列清空后应清零
	if d, _ := s.Deficit("a"); d != 0 {
		t.Fatalf("deficit should be reset, got %d", d)
	}

	// 若赤字未清零，round 2 余额为 7+10=17 足以支付 15；
	// 清零后只有 10，不足以支付。
	mustEnqueue(t, s, "a", drr.Task{ID: "mid", Cost: 15})
	if got := s.RunRound(); len(got) != 0 {
		t.Fatalf("deficit was not reset: round 2 served %v", got)
	}
	if got := s.RunRound(); len(got) != 1 || got[0].TaskID != "mid" {
		t.Fatalf("round 3 should serve mid, got %v", got)
	}
}

func TestWeightUpdateTakesEffectNextRound(t *testing.T) {
	s := newScheduler(t, 10)
	mustAddTenant(t, s, "a", 1)
	mustEnqueue(t, s, "a", drr.Task{ID: "heavy", Cost: 25})

	if err := s.SetWeight("a", 3); err != nil {
		t.Fatalf("SetWeight: %v", err)
	}
	if w, _ := s.Weight("a"); w != 1 {
		t.Fatalf("weight should still be 1 before next round, got %d", w)
	}

	got := s.RunRound() // 权重 3 生效：赤字 30 >= 25
	if len(got) != 1 || got[0].TaskID != "heavy" {
		t.Fatalf("round 1 should serve heavy with new weight, got %v", got)
	}
	if w, _ := s.Weight("a"); w != 3 {
		t.Fatalf("weight should be 3 after round, got %d", w)
	}
}

func TestWeightUpdateNotAppliedMidBacklog(t *testing.T) {
	s := newScheduler(t, 10)
	mustAddTenant(t, s, "a", 1)
	mustEnqueue(t, s, "a", drr.Task{ID: "t1", Cost: 15})

	s.RunRound() // 赤字 10，不够
	if err := s.SetWeight("a", 2); err != nil {
		t.Fatalf("SetWeight: %v", err)
	}
	got := s.RunRound() // 权重 2 生效：10+20=30 >= 15
	if len(got) != 1 || got[0].TaskID != "t1" {
		t.Fatalf("round 2 should serve t1, got %v", got)
	}
}

func TestLedgerRecordsEveryCharge(t *testing.T) {
	s := newScheduler(t, 10)
	mustAddTenant(t, s, "a", 1)
	mustAddTenant(t, s, "b", 2)
	mustEnqueue(t, s, "a", drr.Task{ID: "a1", Cost: 6})
	mustEnqueue(t, s, "a", drr.Task{ID: "a2", Cost: 4})
	mustEnqueue(t, s, "b", drr.Task{ID: "b1", Cost: 15})

	want := []drr.LedgerEntry{
		{Round: 1, TenantID: "a", TaskID: "a1", Cost: 6},
		{Round: 1, TenantID: "a", TaskID: "a2", Cost: 4},
		{Round: 1, TenantID: "b", TaskID: "b1", Cost: 15},
	}
	s.RunRound()
	got := s.Ledger()
	if len(got) != len(want) {
		t.Fatalf("ledger length = %d, want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ledger[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestReactivatedTenantStartsWithZeroDeficit(t *testing.T) {
	s := newScheduler(t, 10)
	mustAddTenant(t, s, "a", 1)
	mustEnqueue(t, s, "a", drr.Task{ID: "first", Cost: 2})
	s.RunRound() // 队列清空，赤字清零并退出活跃列表

	mustEnqueue(t, s, "a", drr.Task{ID: "second", Cost: 12})
	if got := s.RunRound(); len(got) != 0 {
		t.Fatalf("reactivated tenant should start from 0 deficit, served %v", got)
	}
	if got := s.RunRound(); len(got) != 1 || got[0].TaskID != "second" {
		t.Fatalf("round 3 should serve second, got %v", got)
	}
}
