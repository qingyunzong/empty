package formal

import (
	"strings"
	"testing"
	"time"
)

func seqEvents(evs ...Event) []Event {
	for i := range evs {
		evs[i].Seq = int64(i + 1)
		if evs[i].At.IsZero() {
			evs[i].At = at(i)
		}
	}
	return evs
}

func TestReplayDetectsDuplicatePartitionCommit(t *testing.T) {
	res := ResourceSpec{CPUMillis: 1, MemoryMB: 1}
	events := seqEvents(
		Event{Type: EvExecutorRegistered, ExecutorID: "e1"},
		Event{Type: EvExecutorRegistered, ExecutorID: "e2"},
		Event{Type: EvTaskSubmitted, TaskID: "t", Partition: "p", Resource: res},
		Event{Type: EvAttemptScheduled, TaskID: "t", AttemptID: "t#1", ExecutorID: "e1", Kind: AttemptOriginal, Resource: res},
		Event{Type: EvHoldPlaced, TaskID: "t", AttemptID: "t#1", ExecutorID: "e1", Resource: res},
		Event{Type: EvAttemptSucceeded, TaskID: "t", AttemptID: "t#1", ExecutorID: "e1"},
		Event{Type: EvHoldReleased, TaskID: "t", AttemptID: "t#1", ExecutorID: "e1", Resource: res},
		Event{Type: EvPartitionCommitted, TaskID: "t", AttemptID: "t#1", ExecutorID: "e1", Partition: "p"},
		Event{Type: EvPartitionCommitted, TaskID: "t", AttemptID: "t#1", ExecutorID: "e1", Partition: "p"},
	)
	report := Replay(events, testConfig())
	if report.OK() {
		t.Fatal("expected duplicate-commit violation")
	}
}

func TestReplayDetectsBillingLeak(t *testing.T) {
	res := ResourceSpec{CPUMillis: 1, MemoryMB: 1}
	events := seqEvents(
		Event{Type: EvExecutorRegistered, ExecutorID: "e1"},
		Event{Type: EvTaskSubmitted, TaskID: "t", Partition: "p", Resource: res},
		Event{Type: EvAttemptScheduled, TaskID: "t", AttemptID: "t#1", ExecutorID: "e1", Kind: AttemptOriginal, Resource: res},
		Event{Type: EvHoldPlaced, TaskID: "t", AttemptID: "t#1", ExecutorID: "e1", Resource: res},
		// 缺失 HoldReleased：任务既未提交也未失败，且 hold 泄漏。
	)
	report := Replay(events, testConfig())
	if report.OK() {
		t.Fatal("expected billing conservation violation")
	}
}

func TestReplayDetectsPrematureSpeculation(t *testing.T) {
	cfg := testConfig()
	res := ResourceSpec{CPUMillis: 1, MemoryMB: 1}
	events := []Event{
		{Type: EvExecutorRegistered, ExecutorID: "e1", At: at(0)},
		{Type: EvExecutorRegistered, ExecutorID: "e2", At: at(0)},
	}
	seq := int64(2)
	emit := func(ev Event) Event {
		seq++
		ev.Seq = seq
		if ev.At.IsZero() {
			ev.At = at(int(seq))
		}
		events = append(events, ev)
		return ev
	}
	for i := 0; i < 4; i++ {
		tid := TaskID("w" + string(rune('a'+i)))
		part := ShufflePartition("pw" + string(rune('a'+i)))
		start := at(100 * i)
		emit(Event{At: start, Type: EvTaskSubmitted, TaskID: tid, Partition: part, Resource: res})
		emit(Event{At: start, Type: EvAttemptScheduled, TaskID: tid, AttemptID: AttemptID(tid + "#1"), ExecutorID: "e1", Kind: AttemptOriginal, Resource: res})
		emit(Event{At: start, Type: EvHoldPlaced, TaskID: tid, AttemptID: AttemptID(tid + "#1"), ExecutorID: "e1", Resource: res})
		emit(Event{At: start.Add(40 * time.Millisecond), Type: EvAttemptSucceeded, TaskID: tid, AttemptID: AttemptID(tid + "#1"), ExecutorID: "e1"})
		emit(Event{At: start.Add(40 * time.Millisecond), Type: EvHoldReleased, TaskID: tid, AttemptID: AttemptID(tid + "#1"), ExecutorID: "e1", Resource: res})
		emit(Event{At: start.Add(40 * time.Millisecond), Type: EvPartitionCommitted, TaskID: tid, AttemptID: AttemptID(tid + "#1"), ExecutorID: "e1", Partition: part, Runtime: 40 * time.Millisecond})
	}
	// 慢任务在仅运行 5ms（< p90=40ms）时就启动推测副本。
	slowStart := at(1000)
	emit(Event{At: slowStart, Type: EvTaskSubmitted, TaskID: "slow", Partition: "ps", Resource: res})
	emit(Event{At: slowStart, Type: EvAttemptScheduled, TaskID: "slow", AttemptID: "slow#1", ExecutorID: "e1", Kind: AttemptOriginal, Resource: res})
	emit(Event{At: slowStart, Type: EvHoldPlaced, TaskID: "slow", AttemptID: "slow#1", ExecutorID: "e1", Resource: res})
	emit(Event{At: slowStart.Add(5 * time.Millisecond), Type: EvAttemptScheduled, TaskID: "slow", AttemptID: "slow#2", ExecutorID: "e2", Kind: AttemptSpeculative, Resource: res})

	report := Replay(events, cfg)
	found := false
	for _, v := range report.Violations {
		if strings.Contains(v, "before slow threshold") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected premature-speculation violation, got %v", report.Violations)
	}
}
