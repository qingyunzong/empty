package formal_test

import (
	"math/big"
	"testing"

	drf "example.org/dlks/formal/q10086"
)

func TestDominantShareExact(t *testing.T) {
	capacity := drf.Vector{"cpu": 10, "mem": 100}

	tests := []struct {
		name   string
		used   drf.Vector
		weight int64
		want   *big.Rat
	}{
		{
			name:   "memory dominates",
			used:   drf.Vector{"cpu": 3, "mem": 40},
			weight: 1,
			want:   big.NewRat(2, 5),
		},
		{
			name:   "weighted",
			used:   drf.Vector{"cpu": 3, "mem": 40},
			weight: 2,
			want:   big.NewRat(1, 5),
		},
		{
			name:   "exact tie",
			used:   drf.Vector{"cpu": 1, "mem": 10},
			weight: 1,
			want:   big.NewRat(1, 10),
		},
		{
			name:   "zero usage",
			used:   drf.Vector{},
			weight: 7,
			want:   new(big.Rat),
		},
		{
			name:   "missing dimension is zero",
			used:   drf.Vector{"mem": 25},
			weight: 1,
			want:   big.NewRat(1, 4),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := drf.WeightedDominantShare(test.used, capacity, test.weight)
			assertShare(t, got, test.want)
		})
	}

	if got := drf.DominantShare(drf.Vector{"cpu": 1, "mem": 10}, capacity); got.String() != "1/10" {
		t.Fatalf("dominant share = %s, want 1/10", got)
	}
	resource, share := drf.DominantResource(drf.Vector{"cpu": 1, "mem": 10}, capacity)
	if resource != "cpu" || share.String() != "1/10" {
		t.Fatalf("dominant resource = %q %s, want cpu 1/10", resource, share)
	}
}

func TestWeightedQueueShares(t *testing.T) {
	scheduler := drf.MustNewScheduler(drf.Vector{"cpu": 10})
	mustQueue(t, scheduler, drf.Queue{ID: "q1", Weight: 1})
	mustQueue(t, scheduler, drf.Queue{ID: "q2", Weight: 2})

	for i := 0; i < 9; i++ {
		queue := "q1"
		if i%3 != 0 {
			queue = "q2"
		}
		mustSubmit(t, scheduler, drf.Task{
			ID:      taskID(queue, i),
			QueueID: queue,
			Demand:  drf.Vector{"cpu": 1},
		})
	}
	decision, err := scheduler.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	if len(decision.Admitted) != 9 {
		t.Fatalf("admitted %d tasks, want 9", len(decision.Admitted))
	}
	q1, err := scheduler.QueueUsage("q1")
	if err != nil {
		t.Fatal(err)
	}
	q2, err := scheduler.QueueUsage("q2")
	if err != nil {
		t.Fatal(err)
	}
	if q1["cpu"] != 3 || q2["cpu"] != 6 {
		t.Fatalf("usage q1=%d q2=%d, want 3 and 6", q1["cpu"], q2["cpu"])
	}
	q1Share, _ := scheduler.QueueShare("q1")
	q2Share, _ := scheduler.QueueShare("q2")
	assertShare(t, q1Share, big.NewRat(3, 10))
	assertShare(t, q2Share, big.NewRat(3, 10))
}

func TestGangIsAtomic(t *testing.T) {
	scheduler := drf.MustNewScheduler(drf.Vector{"cpu": 10})
	mustQueue(t, scheduler, drf.Queue{ID: "q"})
	mustSubmit(t, scheduler, drf.Task{
		ID:       "first",
		QueueID:  "q",
		Demand:   drf.Vector{"cpu": 3},
		GangSize: 2,
	})
	mustSubmit(t, scheduler, drf.Task{
		ID:       "second",
		QueueID:  "q",
		Demand:   drf.Vector{"cpu": 3},
		GangSize: 2,
	})
	mustSubmit(t, scheduler, drf.Task{
		ID:       "impossible",
		QueueID:  "q",
		Demand:   drf.Vector{"cpu": 6},
		GangSize: 2,
	})

	decision, err := scheduler.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	if len(decision.Admitted) != 1 || decision.Admitted[0].TaskID != "first" {
		t.Fatalf("admitted = %v, want only first", allocationIDs(decision.Admitted))
	}
	first, _ := scheduler.AllocationOf("first")
	if first.Resources["cpu"] != 6 {
		t.Fatalf("first holds %d cpu, want 6", first.Resources["cpu"])
	}
	second, _ := scheduler.AllocationOf("second")
	if !second.Resources.IsZero() {
		t.Fatalf("second partially admitted: %s", second.Resources)
	}
	status, _ := scheduler.StatusOf("second")
	if status != drf.StatusWaiting {
		t.Fatalf("second status = %s, want waiting", status)
	}
	assertInvariants(t, scheduler, "gang wait")

	if err := scheduler.Complete("first"); err != nil {
		t.Fatal(err)
	}
	decision, err = scheduler.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	if len(decision.Admitted) != 1 || decision.Admitted[0].TaskID != "second" {
		t.Fatalf("admitted after release = %v, want second", allocationIDs(decision.Admitted))
	}
	second, _ = scheduler.AllocationOf("second")
	if second.Resources["cpu"] != 6 {
		t.Fatalf("second holds %d cpu, want 6", second.Resources["cpu"])
	}
	assertInvariants(t, scheduler, "gang admit")
}

func TestPreemptionOrderAndConservation(t *testing.T) {
	scheduler := drf.MustNewScheduler(drf.Vector{"cpu": 10, "mem": 10})
	mustQueue(t, scheduler, drf.Queue{ID: "a"})
	mustQueue(t, scheduler, drf.Queue{ID: "b"})
	mustQueue(t, scheduler, drf.Queue{ID: "c"})

	submissions := []drf.Task{
		{ID: "a-large", QueueID: "a", Demand: drf.Vector{"cpu": 6, "mem": 1}},
		{ID: "b-large", QueueID: "b", Demand: drf.Vector{"cpu": 1, "mem": 6}},
		{ID: "b-small", QueueID: "b", Demand: drf.Vector{"cpu": 1, "mem": 2}},
		{ID: "a-small", QueueID: "a", Demand: drf.Vector{"cpu": 2, "mem": 1}},
	}
	for _, task := range submissions {
		mustSubmit(t, scheduler, task)
	}
	mustAllocate(t, scheduler)
	assertInvariants(t, scheduler, "preemption setup")

	before := scheduler.Snapshot()
	mustSubmit(t, scheduler, drf.Task{
		ID:      "c-new",
		QueueID: "c",
		Demand:  drf.Vector{"cpu": 5, "mem": 5},
	})
	decision, err := scheduler.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	if got := allocationIDs(decision.Admitted); len(got) != 1 || got[0] != "c-new" {
		t.Fatalf("admitted = %v, want [c-new]", got)
	}
	wantVictims := []string{"a-large", "b-large"}
	if got := allocationIDs(decision.Preempted); !equalStrings(got, wantVictims) {
		t.Fatalf("preempted = %v, want %v", got, wantVictims)
	}

	after := scheduler.Snapshot()
	for name, amount := range after.Used {
		want := before.Used[name]
		for _, victim := range decision.Preempted {
			want -= victim.Resources[name]
		}
		for _, admitted := range decision.Admitted {
			want += admitted.Resources[name]
		}
		if amount != want {
			t.Fatalf("resource %s after preemption = %d, want %d", name, amount, want)
		}
	}
	if !after.Used.Fits(after.Capacity) {
		t.Fatalf("overcommit after preemption: %s > %s", after.Used, after.Capacity)
	}
	assertInvariants(t, scheduler, "after preemption")
}

func TestExplicitPreemptRequeuesWholeGang(t *testing.T) {
	scheduler := drf.MustNewScheduler(drf.Vector{"cpu": 8, "mem": 8})
	mustQueue(t, scheduler, drf.Queue{ID: "q"})
	mustSubmit(t, scheduler, drf.Task{
		ID:       "g",
		QueueID:  "q",
		Demand:   drf.Vector{"cpu": 2, "mem": 1},
		GangSize: 3,
	})
	mustAllocate(t, scheduler)
	allocation, err := scheduler.Preempt("g")
	if err != nil {
		t.Fatal(err)
	}
	if allocation.Resources["cpu"] != 6 || allocation.Resources["mem"] != 3 {
		t.Fatalf("preempted resources = %s, want {cpu=6,mem=3}", allocation.Resources)
	}
	status, _ := scheduler.StatusOf("g")
	if status != drf.StatusWaiting {
		t.Fatalf("status = %s, want waiting", status)
	}
	assertInvariants(t, scheduler, "explicit preempt")
}

func TestPreemptionVictimsDescendByExactShare(t *testing.T) {
	scheduler := drf.MustNewScheduler(drf.Vector{"cpu": 10, "mem": 10})
	for _, id := range []string{"q1", "q2", "q3", "q4"} {
		mustQueue(t, scheduler, drf.Queue{ID: id})
	}
	for _, task := range []drf.Task{
		{ID: "share-7", QueueID: "q1", Demand: drf.Vector{"cpu": 7, "mem": 1}},
		{ID: "share-6", QueueID: "q2", Demand: drf.Vector{"cpu": 2, "mem": 6}},
		{ID: "share-3", QueueID: "q3", Demand: drf.Vector{"cpu": 1, "mem": 3}},
	} {
		mustSubmit(t, scheduler, task)
	}
	mustAllocate(t, scheduler)
	assertInvariants(t, scheduler, "descending victim setup")

	mustSubmit(t, scheduler, drf.Task{
		ID:      "incoming",
		QueueID: "q4",
		Demand:  drf.Vector{"cpu": 5, "mem": 5},
	})
	decision := mustAllocate(t, scheduler)
	if got := allocationIDs(decision.Preempted); !equalStrings(got, []string{"share-7", "share-6"}) {
		t.Fatalf("preempted = %v, want [share-7 share-6]", got)
	}
	if got := allocationIDs(decision.Admitted); !equalStrings(got, []string{"incoming"}) {
		t.Fatalf("admitted = %v, want [incoming]", got)
	}
	assertInvariants(t, scheduler, "descending victims")
}

func TestAutomaticPreemptionReleasesWholeGang(t *testing.T) {
	scheduler := drf.MustNewScheduler(drf.Vector{"cpu": 10})
	mustQueue(t, scheduler, drf.Queue{ID: "gang"})
	mustQueue(t, scheduler, drf.Queue{ID: "incoming"})
	mustSubmit(t, scheduler, drf.Task{
		ID:       "gang-task",
		QueueID:  "gang",
		Demand:   drf.Vector{"cpu": 3},
		GangSize: 2,
	})
	mustAllocate(t, scheduler)

	mustSubmit(t, scheduler, drf.Task{
		ID:      "new-task",
		QueueID: "incoming",
		Demand:  drf.Vector{"cpu": 5},
	})
	decision := mustAllocate(t, scheduler)
	if got := allocationIDs(decision.Preempted); !equalStrings(got, []string{"gang-task"}) {
		t.Fatalf("preempted = %v, want [gang-task]", got)
	}
	if got := decision.Preempted[0].Resources["cpu"]; got != 6 {
		t.Fatalf("preempted gang cpu = %d, want 6", got)
	}
	gangAllocation, _ := scheduler.AllocationOf("gang-task")
	if !gangAllocation.Resources.IsZero() {
		t.Fatalf("gang task still holds %s after preemption", gangAllocation.Resources)
	}
	assertInvariants(t, scheduler, "whole gang preemption")
}

func TestSubmittedDemandIsImmutable(t *testing.T) {
	scheduler := drf.MustNewScheduler(drf.Vector{"cpu": 4})
	mustQueue(t, scheduler, drf.Queue{ID: "q"})
	demand := drf.Vector{"cpu": 2}
	mustSubmit(t, scheduler, drf.Task{ID: "t", QueueID: "q", Demand: demand})
	demand["cpu"] = 100

	mustAllocate(t, scheduler)
	allocation, _ := scheduler.AllocationOf("t")
	if allocation.Resources["cpu"] != 2 {
		t.Fatalf("task resources = %d, want original demand 2", allocation.Resources["cpu"])
	}
	info, _ := scheduler.TaskInfo("t")
	if info.Demand["cpu"] != 2 {
		t.Fatalf("stored demand = %d, want 2", info.Demand["cpu"])
	}
	assertInvariants(t, scheduler, "immutable demand")
}

func TestValidationAndDefaultQueue(t *testing.T) {
	if _, err := drf.NewScheduler(nil); err == nil {
		t.Fatal("empty capacity should be rejected")
	}
	scheduler := drf.MustNewScheduler(drf.Vector{"cpu": 4})
	if err := scheduler.AddQueue(drf.Queue{}); err == nil {
		t.Fatal("empty queue ID should be rejected")
	}

	if err := scheduler.Submit(drf.Task{
		Demand: drf.Vector{"cpu": 1},
	}); err != nil {
		t.Fatalf("default queue submission failed: %v", err)
	}
	if err := scheduler.Submit(drf.Task{
		ID:      "bad-resource",
		QueueID: drf.DefaultQueueID,
		Demand:  drf.Vector{"gpu": 1},
	}); err == nil {
		t.Fatal("unknown resource should be rejected")
	}
	if err := scheduler.Submit(drf.Task{
		ID:       "bad-gang",
		QueueID:  drf.DefaultQueueID,
		Demand:   drf.Vector{"cpu": 1},
		GangSize: -1,
	}); err == nil {
		t.Fatal("negative gang size should be rejected")
	}
	if err := scheduler.Submit(drf.Task{
		ID:      "bad-weight",
		QueueID: drf.DefaultQueueID,
		Demand:  drf.Vector{"cpu": 1},
		Weight:  -1,
	}); err == nil {
		t.Fatal("negative task weight should be rejected")
	}

	mustAllocate(t, scheduler)
	assertInvariants(t, scheduler, "default queue")
}

func assertShare(t *testing.T, got drf.Share, want *big.Rat) {
	t.Helper()
	if want == nil {
		if !got.IsInf() {
			t.Fatalf("share = %s, want inf", got)
		}
		return
	}
	if got.IsInf() {
		t.Fatalf("share = inf, want %s", want.RatString())
	}
	rat := got.Rat()
	if rat == nil {
		rat = new(big.Rat)
	}
	if rat.Cmp(want) != 0 {
		t.Fatalf("share = %s, want %s", rat.RatString(), want.RatString())
	}
}

func assertInvariants(t *testing.T, scheduler *drf.Scheduler, context string) {
	t.Helper()
	if err := scheduler.Validate(); err != nil {
		t.Fatalf("%s: %v", context, err)
	}
	snapshot := scheduler.Snapshot()
	if !snapshot.Used.Fits(snapshot.Capacity) {
		t.Fatalf("%s: overcommit %s > %s", context, snapshot.Used, snapshot.Capacity)
	}
	if !snapshot.Capacity.Sub(snapshot.Used).Equal(snapshot.Free) {
		t.Fatalf("%s: free resources %s do not match capacity-used %s", context, snapshot.Free, snapshot.Capacity.Sub(snapshot.Used))
	}

	global := make(drf.Vector)
	queueTotals := make(map[string]drf.Vector)
	for id, queue := range snapshot.Queues {
		queueTotal := make(drf.Vector)
		for _, allocation := range queue.Running {
			info, ok := scheduler.TaskInfo(allocation.TaskID)
			if !ok {
				t.Fatalf("%s: missing task info for %s", context, allocation.TaskID)
			}
			if info.Status != drf.StatusRunning {
				t.Fatalf("%s: queued allocation %s has status %s", context, allocation.TaskID, info.Status)
			}
			expected := info.Demand.Mul(int64(info.GangSize))
			if !info.Resources.Equal(expected) {
				t.Fatalf("%s: task %s holds %s, want full gang %s", context, allocation.TaskID, info.Resources, expected)
			}
			if !allocation.Resources.Equal(info.Resources) {
				t.Fatalf("%s: allocation view %s differs from task info %s", context, allocation.Resources, info.Resources)
			}
			for name, amount := range allocation.Resources {
				queueTotal[name] += amount
				global[name] += amount
			}
			wantTaskShare := naiveShare(allocation.Resources, snapshot.Capacity, queue.Weight*info.Weight)
			assertShare(t, info.DominantShare, wantTaskShare)
			assertShare(t, allocation.DominantShare, wantTaskShare)
		}
		queueTotals[id] = queueTotal
		if !queue.Used.Equal(queueTotal) {
			t.Fatalf("%s: queue %s used %s, want %s", context, id, queue.Used, queueTotal)
		}
		usage, err := scheduler.QueueUsage(id)
		if err != nil {
			t.Fatal(err)
		}
		if !usage.Equal(queueTotal) {
			t.Fatalf("%s: QueueUsage(%s) = %s, want %s", context, id, usage, queueTotal)
		}
		wantQueueShare := naiveShare(queueTotal, snapshot.Capacity, queue.Weight)
		assertShare(t, queue.Share, wantQueueShare)
		gotQueueShare, err := scheduler.QueueShare(id)
		if err != nil {
			t.Fatal(err)
		}
		assertShare(t, gotQueueShare, wantQueueShare)
		for _, taskID := range queue.Waiting {
			status, err := scheduler.StatusOf(taskID)
			if err != nil {
				t.Fatal(err)
			}
			if status != drf.StatusWaiting {
				t.Fatalf("%s: queued task %s has status %s", context, taskID, status)
			}
			allocation, _ := scheduler.AllocationOf(taskID)
			if !allocation.Resources.IsZero() {
				t.Fatalf("%s: waiting task %s holds %s", context, taskID, allocation.Resources)
			}
		}
	}
	if !global.Equal(snapshot.Used) {
		t.Fatalf("%s: sum of queue usage %s != global used %s", context, global, snapshot.Used)
	}
}

func naiveShare(used, capacity drf.Vector, weight int64) *big.Rat {
	if weight <= 0 {
		weight = 1
	}
	names := make(map[string]struct{})
	for name := range used {
		names[name] = struct{}{}
	}
	for name := range capacity {
		names[name] = struct{}{}
	}
	best := new(big.Rat)
	weightRat := big.NewRat(weight, 1)
	for name := range names {
		amount := used[name]
		if amount <= 0 {
			continue
		}
		if capacity[name] <= 0 {
			return nil
		}
		candidate := big.NewRat(amount, capacity[name])
		candidate.Quo(candidate, weightRat)
		if candidate.Cmp(best) > 0 {
			best = candidate
		}
	}
	return best
}

func mustQueue(t *testing.T, scheduler *drf.Scheduler, queue drf.Queue) {
	t.Helper()
	if err := scheduler.AddQueue(queue); err != nil {
		t.Fatal(err)
	}
}

func mustSubmit(t *testing.T, scheduler *drf.Scheduler, task drf.Task) {
	t.Helper()
	if err := scheduler.Submit(task); err != nil {
		t.Fatal(err)
	}
}

func mustAllocate(t *testing.T, scheduler *drf.Scheduler) *drf.Decision {
	t.Helper()
	decision, err := scheduler.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	return decision
}

func allocationIDs(allocations []drf.Allocation) []string {
	ids := make([]string, 0, len(allocations))
	for _, allocation := range allocations {
		ids = append(ids, allocation.TaskID)
	}
	return ids
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func taskID(queue string, index int) string {
	return queue + "-" + string(rune('a'+index))
}
