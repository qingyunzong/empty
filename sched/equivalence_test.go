package sched

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

// 虚拟时钟重放与逐轮朴素模型核对：随机负载下两者必须产生完全一致
// 的调度记录与账单，且无饥饿（每个未取消的任务最终完成）、费用准确
// （取消排队任务零费用、取消运行任务只计已消耗部分、账实相符）。
func TestReplayMatchesNaive(t *testing.T) {
	for seed := int64(0); seed < 300; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			quantum := 1 + rng.Int63n(5)
			urgentCap := 1 + rng.Intn(3)
			tenants := []string{"A", "B", "C", "D"}[:1+rng.Intn(4)]

			nTasks := 3 + rng.Intn(28)
			var events []Event
			tasks := make(map[string]Task)
			for i := 0; i < nTasks; i++ {
				task := Task{
					ID:       fmt.Sprintf("t%d", i),
					Tenant:   tenants[rng.Intn(len(tenants))],
					Cost:     1 + rng.Int63n(15),
					Duration: 1 + rng.Int63n(6),
					Urgent:   rng.Intn(4) == 0,
				}
				at := rng.Int63n(25)
				events = append(events, submitAt(at, task))
				tasks[task.ID] = task
				// Roughly a third of tasks get a cancel attempt; depending
				// on timing it may hit a queued, running, or finished task.
				if rng.Intn(3) == 0 {
					events = append(events, cancelAt(at+rng.Int63n(12), task.ID))
				}
			}

			replay, err := NewReplayScheduler(quantum, urgentCap, events)
			if err != nil {
				t.Fatal(err)
			}
			replay.Run()
			naive, err := NewNaiveScheduler(quantum, urgentCap, events)
			if err != nil {
				t.Fatal(err)
			}
			naive.Run()

			gotRecs, wantRecs := replay.Records(), naive.Records()
			if !reflect.DeepEqual(gotRecs, wantRecs) {
				t.Fatalf("records diverge:\nreplay: %v\nnaive:  %v", gotRecs, wantRecs)
			}
			if !reflect.DeepEqual(replay.Accounts(), naive.Accounts()) {
				t.Fatalf("accounts diverge: replay %v, naive %v", replay.Accounts(), naive.Accounts())
			}

			// Invariants on the (identical) outcomes.
			seen := make(map[string]Record)
			chargedPerTenant := make(map[string]int64)
			for _, r := range gotRecs {
				if _, dup := seen[r.TaskID]; dup {
					t.Fatalf("duplicate record for %s", r.TaskID)
				}
				seen[r.TaskID] = r
				task := tasks[r.TaskID]
				if r.Charged < 0 {
					t.Fatalf("%s: negative charge %d", r.TaskID, r.Charged)
				}
				switch {
				case !r.Cancelled:
					// No starvation: every surviving task completed and is
					// billed exactly its cost.
					if r.DispatchRound < 0 || r.FinishRound != r.DispatchRound+task.Duration {
						t.Fatalf("%s: bad lifecycle %+v", r.TaskID, r)
					}
					if r.Charged != task.Cost {
						t.Fatalf("%s: charged %d, want %d", r.TaskID, r.Charged, task.Cost)
					}
				case r.DispatchRound == -1:
					// Cancelled while queued: no phantom charge.
					if r.Charged != 0 {
						t.Fatalf("%s: queued cancel charged %d, want 0", r.TaskID, r.Charged)
					}
				default:
					// Cancelled while running: pay only the consumed share.
					remaining := r.DispatchRound + task.Duration - r.FinishRound
					want := task.Cost - task.Cost*remaining/task.Duration
					if r.Charged != want {
						t.Fatalf("%s: charged %d, want %d", r.TaskID, r.Charged, want)
					}
				}
				chargedPerTenant[r.Tenant] += r.Charged
			}
			// Every submitted task has exactly one record: none lost, none starved.
			for id := range tasks {
				if _, ok := seen[id]; !ok {
					t.Fatalf("task %s vanished (starvation?)", id)
				}
			}
			// Accounts match the sum of per-task charges.
			for tenant, total := range replay.Accounts() {
				if chargedPerTenant[tenant] != total {
					t.Fatalf("tenant %s: account %d, records sum %d", tenant, total, chargedPerTenant[tenant])
				}
			}
		})
	}
}
