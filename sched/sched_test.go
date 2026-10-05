package sched

import (
	"testing"
)

func submitAt(round int64, t Task) Event { return Event{Round: round, Kind: Submit, Task: t} }
func cancelAt(round int64, id string) Event {
	return Event{Round: round, Kind: Cancel, TaskID: id}
}

func recordByID(t *testing.T, recs []Record, id string) Record {
	t.Helper()
	for _, r := range recs {
		if r.TaskID == id {
			return r
		}
	}
	t.Fatalf("no record for task %s", id)
	return Record{}
}

// 每轮增加整数额度；大任务（费用超过单轮额度）跨轮积累后调度。
func TestIntegerQuotaAndCrossRoundAccumulation(t *testing.T) {
	s, err := NewReplayScheduler(5, 2, []Event{
		submitAt(0, Task{ID: "big", Tenant: "A", Cost: 12, Duration: 1}),
		submitAt(0, Task{ID: "mid", Tenant: "A", Cost: 7, Duration: 1}),
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Run()
	recs := s.Records()

	// Deficit grows by exactly 5 per round: 5, 10, 15 -> big dispatches at round 2.
	big := recordByID(t, recs, "big")
	if big.DispatchRound != 2 {
		t.Fatalf("big dispatched at round %d, want 2", big.DispatchRound)
	}
	if big.Charged != 12 {
		t.Fatalf("big charged %d, want 12", big.Charged)
	}
	// After big: deficit 15-12=3; round 3 adds 5 -> 8 >= 7 -> mid at round 3.
	mid := recordByID(t, recs, "mid")
	if mid.DispatchRound != 3 {
		t.Fatalf("mid dispatched at round %d, want 3", mid.DispatchRound)
	}
	if got := s.Accounts()["A"]; got != 19 {
		t.Fatalf("account A = %d, want 19", got)
	}
}

// 按租户轮询：两个租户公平交替。
func TestRoundRobinAlternation(t *testing.T) {
	var events []Event
	for _, id := range []string{"a1", "a2", "a3"} {
		events = append(events, submitAt(0, Task{ID: id, Tenant: "A", Cost: 1, Duration: 1}))
	}
	for _, id := range []string{"b1", "b2", "b3"} {
		events = append(events, submitAt(0, Task{ID: id, Tenant: "B", Cost: 1, Duration: 1}))
	}
	s, err := NewReplayScheduler(1, 2, events)
	if err != nil {
		t.Fatal(err)
	}
	s.Run()

	wantOrder := []string{"a1", "b1", "a2", "b2", "a3", "b3"}
	recs := s.Records()
	if len(recs) != len(wantOrder) {
		t.Fatalf("got %d records, want %d", len(recs), len(wantOrder))
	}
	for i, id := range wantOrder {
		if recs[i].TaskID != id {
			t.Fatalf("dispatch %d = %s, want %s", i, recs[i].TaskID, id)
		}
		if recs[i].DispatchRound != int64(i/2) {
			t.Fatalf("%s dispatched at round %d, want %d", id, recs[i].DispatchRound, i/2)
		}
	}
	if s.Accounts()["A"] != 3 || s.Accounts()["B"] != 3 {
		t.Fatalf("accounts = %v, want A=3 B=3", s.Accounts())
	}
}

// 紧急任务每轮最多插入两件，且不消耗租户额度。
func TestUrgentCapTwoPerRound(t *testing.T) {
	var events []Event
	for _, id := range []string{"u1", "u2", "u3", "u4", "u5"} {
		events = append(events, submitAt(0, Task{ID: id, Tenant: "T", Cost: 1, Duration: 1, Urgent: true}))
	}
	events = append(events, submitAt(0, Task{ID: "r1", Tenant: "T", Cost: 1, Duration: 1}))
	s, err := NewReplayScheduler(1, 2, events)
	if err != nil {
		t.Fatal(err)
	}
	s.Run()
	recs := s.Records()

	wantRound := map[string]int64{"u1": 0, "u2": 0, "u3": 1, "u4": 1, "u5": 2, "r1": 0}
	for id, want := range wantRound {
		if got := recordByID(t, recs, id).DispatchRound; got != want {
			t.Fatalf("%s dispatched at round %d, want %d", id, got, want)
		}
	}
	// Urgent tasks never touch the tenant deficit: r1 still dispatched at
	// round 0 using the round-0 quantum.
	if got := s.Accounts()["T"]; got != 6 {
		t.Fatalf("account T = %d, want 6", got)
	}
}

// 取消排队中的任务：零费用，账户不留虚扣费。
func TestCancelQueuedLeavesNoCharge(t *testing.T) {
	s, err := NewReplayScheduler(1, 2, []Event{
		submitAt(0, Task{ID: "big", Tenant: "A", Cost: 100, Duration: 5}),
		cancelAt(3, "big"),
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Run()
	recs := s.Records()
	if len(recs) != 1 {
		t.Fatalf("got %d records, want 1", len(recs))
	}
	r := recs[0]
	if !r.Cancelled || r.DispatchRound != -1 || r.Charged != 0 {
		t.Fatalf("record = %+v, want cancelled, undispatched, charged 0", r)
	}
	if got := s.Accounts()["A"]; got != 0 {
		t.Fatalf("account A = %d, want 0 (no phantom charge)", got)
	}
}

// 取消运行中的任务：只按已消耗部分计费，退还未用部分。
func TestCancelRunningRefundsUnused(t *testing.T) {
	s, err := NewReplayScheduler(10, 2, []Event{
		submitAt(0, Task{ID: "job", Tenant: "A", Cost: 10, Duration: 10}),
		cancelAt(4, "job"),
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Run()
	r := recordByID(t, s.Records(), "job")
	// Dispatched at round 0, cancelled at round 4: 4/10 consumed.
	if !r.Cancelled || r.DispatchRound != 0 || r.FinishRound != 4 {
		t.Fatalf("record = %+v, want cancelled at round 4", r)
	}
	if r.Charged != 4 {
		t.Fatalf("charged %d, want 4 (refund 6 for unused rounds)", r.Charged)
	}
	if got := s.Accounts()["A"]; got != 4 {
		t.Fatalf("account A = %d, want 4", got)
	}
}

// 虚拟时钟重放：巨额费用任务直接跳轮，无需逐轮模拟。
func TestReplaySkipsIdleRounds(t *testing.T) {
	const cost = 1_000_000_000
	s, err := NewReplayScheduler(1, 2, []Event{
		submitAt(0, Task{ID: "huge", Tenant: "A", Cost: cost, Duration: 1}),
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Run()
	r := recordByID(t, s.Records(), "huge")
	// Deficit after round r is r+1, so cost 1e9 is reached at round 1e9-1.
	if r.DispatchRound != cost-1 {
		t.Fatalf("huge dispatched at round %d, want %d", r.DispatchRound, cost-1)
	}
	if got := s.Accounts()["A"]; got != cost {
		t.Fatalf("account A = %d, want %d", got, cost)
	}
}

// 取消不存在的或已完成的任务是无害 no-op。
func TestCancelUnknownOrFinishedIsNoop(t *testing.T) {
	s, err := NewReplayScheduler(1, 2, []Event{
		submitAt(0, Task{ID: "x", Tenant: "A", Cost: 1, Duration: 1}),
		cancelAt(0, "ghost"),
		cancelAt(5, "x"), // x finished at round 1
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Run()
	r := recordByID(t, s.Records(), "x")
	if r.Cancelled || r.Charged != 1 {
		t.Fatalf("record = %+v, want completed, charged 1", r)
	}
	if got := s.Accounts()["A"]; got != 1 {
		t.Fatalf("account A = %d, want 1", got)
	}
}

func TestValidation(t *testing.T) {
	if _, err := NewReplayScheduler(0, 2, nil); err == nil {
		t.Fatal("want error for quantum 0")
	}
	if _, err := NewReplayScheduler(1, 0, nil); err == nil {
		t.Fatal("want error for urgent cap 0")
	}
	dup := []Event{
		submitAt(0, Task{ID: "x", Tenant: "A", Cost: 1, Duration: 1}),
		submitAt(1, Task{ID: "x", Tenant: "A", Cost: 1, Duration: 1}),
	}
	if _, err := NewReplayScheduler(1, 2, dup); err == nil {
		t.Fatal("want error for duplicate task ID")
	}
	bad := []Event{submitAt(0, Task{ID: "x", Tenant: "A", Cost: 0, Duration: 1})}
	if _, err := NewReplayScheduler(1, 2, bad); err == nil {
		t.Fatal("want error for cost 0")
	}
}
