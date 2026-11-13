package dataeng

import (
	"reflect"
	"testing"
)

func mustOperator(t *testing.T, cfg Config) *Operator {
	t.Helper()
	op, err := NewOperator(cfg)
	if err != nil {
		t.Fatalf("NewOperator: %v", err)
	}
	return op
}

func processEvent(t *testing.T, op *Operator, ev Event) ([]WindowResult, []SideOutput) {
	t.Helper()
	results, sides, err := op.Process(ev)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	return results, sides
}

func advance(t *testing.T, op *Operator, partition, source string, ts int64) []WindowResult {
	t.Helper()
	results, err := op.AdvanceWatermark(partition, source, ts)
	if err != nil {
		t.Fatalf("AdvanceWatermark: %v", err)
	}
	return results
}

func TestTumblingRevisionAndSideOutput(t *testing.T) {
	op := mustOperator(t, Config{
		Window:          Tumbling(10),
		AllowedLateness: 5,
		Aggregate: func(_ WindowContext, events []Event) any {
			return len(events)
		},
	})

	results, sides := processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 1, Value: "a"})
	if len(results) != 0 || len(sides) != 0 {
		t.Fatalf("event before watermark should be buffered, got results=%v sides=%v", results, sides)
	}

	results = advance(t, op, "p", "s1", 10)
	if len(results) != 1 {
		t.Fatalf("expected one initial trigger, got %d", len(results))
	}
	got := results[0]
	if got.Window != (Window{0, 10}) || got.Version != 1 || got.Late || got.Aggregate != 1 {
		t.Fatalf("unexpected initial result: %+v", got)
	}

	results, sides = processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 5, Value: "b"})
	if len(results) != 1 || len(sides) != 0 {
		t.Fatalf("expected late revision, got results=%v sides=%v", results, sides)
	}
	if got := results[0]; got.Version != 2 || !got.Late || got.Aggregate != 2 || len(got.Events) != 2 {
		t.Fatalf("unexpected revision: %+v", got)
	}

	results, sides = processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 9, Value: "c"})
	if len(results) != 1 || results[0].Version != 3 || results[0].Aggregate != 3 {
		t.Fatalf("expected version 3, got %+v", results)
	}

	if results := advance(t, op, "p", "s1", 14); len(results) != 0 {
		t.Fatalf("no window ends in (10,14], got %v", results)
	}
	if results := advance(t, op, "p", "s1", 15); len(results) != 0 {
		t.Fatalf("finalization must not emit an extra revision, got %v", results)
	}

	results, sides = processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 8, Value: "too-late"})
	if len(results) != 0 || len(sides) != 1 {
		t.Fatalf("expected side output only, got results=%v sides=%v", results, sides)
	}
	if sides[0].Reason != SideOutputAfterDeadline || !reflect.DeepEqual(sides[0].Windows, []Window{{0, 10}}) {
		t.Fatalf("unexpected side output: %+v", sides[0])
	}
}

func TestPartitionWatermarkUsesMinimumActiveSource(t *testing.T) {
	op := mustOperator(t, Config{Window: Tumbling(10)})

	processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 1})
	processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 11})
	processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 21})
	processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 31})

	if results := advance(t, op, "p", "s2", 5); len(results) != 0 {
		t.Fatalf("partition watermark 5 must not trigger [0,10), got %v", results)
	}
	if results := advance(t, op, "p", "s1", 20); len(results) != 0 {
		t.Fatalf("minimum is still 5, got %v", results)
	}
	if wm, ok := op.Watermark("p"); !ok || wm != 5 {
		t.Fatalf("watermark = %d,%v want 5,true", wm, ok)
	}

	// The slow source explicitly leaves the active set; the partition
	// watermark jumps to the remaining source and triggers in end order.
	results := advance(t, op, "p", "s2", 5) // no change; keep the source known
	if len(results) != 0 {
		t.Fatalf("unexpected results: %v", results)
	}
	results, err := op.MarkIdle("p", "s2")
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 {
		t.Fatalf("expected two windows, got %d: %+v", len(results), results)
	}
	if results[0].Window != (Window{0, 10}) || results[1].Window != (Window{10, 20}) {
		t.Fatalf("wrong trigger order: %v", results)
	}

	if wm, ok := op.Watermark("p"); !ok || wm != 20 {
		t.Fatalf("watermark = %d,%v want 20,true", wm, ok)
	}

	// Reactivating an idle source fast-forwards it to the partition
	// watermark, so the partition watermark never regresses.
	if results := advance(t, op, "p", "s3", 6); len(results) != 0 {
		t.Fatalf("unexpected results: %v", results)
	}
	results = advance(t, op, "p", "s1", 30)
	if len(results) != 0 {
		t.Fatalf("s3 was fast-forwarded to 20 and s1 to 30; minimum 20 should not trigger, got %v", results)
	}
	if wm, ok := op.Watermark("p"); !ok || wm != 20 {
		t.Fatalf("watermark = %d,%v want 20,true", wm, ok)
	}

	results, err = op.Heartbeat(Heartbeat{Partition: "p", Source: "s2", Timestamp: 50, Idle: false})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("unexpected results: %v", results)
	}
	if wm, ok := op.Watermark("p"); !ok || wm != 20 {
		t.Fatalf("minimum across s1=30,s2=50,s3=20 is 20, got %d,%v", wm, ok)
	}

	results = advance(t, op, "p", "s3", 40)
	if len(results) != 1 || results[0].Window != (Window{20, 30}) {
		t.Fatalf("expected [20,30), got %v", results)
	}
	results = advance(t, op, "p", "s1", 40)
	if len(results) != 1 || results[0].Window != (Window{30, 40}) {
		t.Fatalf("expected [30,40), got %v", results)
	}

	infos := op.Sources("p")
	if len(infos) != 3 {
		t.Fatalf("sources = %v", infos)
	}
	if infos[0].ID != "s1" || infos[0].Idle {
		t.Fatalf("unexpected source info: %+v", infos)
	}
}

func TestIdleHeartbeatExcludesSource(t *testing.T) {
	op := mustOperator(t, Config{Window: Tumbling(10)})
	processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 2})

	advance(t, op, "p", "slow", 1)
	advance(t, op, "p", "fast", 20)
	if wm, ok := op.Watermark("p"); !ok || wm != 1 {
		t.Fatalf("minimum should be 1, got %d,%v", wm, ok)
	}

	results, err := op.Heartbeat(Heartbeat{Partition: "p", Source: "slow", Timestamp: 1, Idle: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Version != 1 || results[0].Late {
		t.Fatalf("unexpected trigger: %v", results)
	}
	if wm, ok := op.Watermark("p"); !ok || wm != 20 {
		t.Fatalf("watermark = %d,%v want 20", wm, ok)
	}
}

func TestSlidingRevisionsAndPartialSideOutput(t *testing.T) {
	op := mustOperator(t, Config{Window: Sliding(10, 5), AllowedLateness: 3})

	processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 6, Value: "a"})
	results := advance(t, op, "p", "s", 10)
	if len(results) != 1 || results[0].Window != (Window{0, 10}) || results[0].Version != 1 {
		t.Fatalf("unexpected initial trigger: %v", results)
	}

	results, sides := processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 7, Value: "b"})
	if len(sides) != 0 || len(results) != 1 {
		t.Fatalf("expected one revision and no side output, got %v / %v", results, sides)
	}
	if results[0].Window != (Window{0, 10}) || results[0].Version != 2 {
		t.Fatalf("unexpected revision: %v", results)
	}

	results = advance(t, op, "p", "s", 15)
	if len(results) != 1 || results[0].Window != (Window{5, 15}) || results[0].Version != 1 {
		t.Fatalf("unexpected second trigger: %v", results)
	}

	// At watermark 15, [0,10)+3 is closed but [5,15)+3 is still open.
	results, sides = processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 8, Value: "c"})
	if len(sides) != 1 || !reflect.DeepEqual(sides[0].Windows, []Window{{0, 10}}) {
		t.Fatalf("unexpected side output: %+v", sides)
	}
	if len(results) != 1 || results[0].Window != (Window{5, 15}) || results[0].Version != 2 {
		t.Fatalf("unexpected revision: %v", results)
	}
}

func TestSlidingGapGoesToNoWindowSideOutput(t *testing.T) {
	op := mustOperator(t, Config{Window: Sliding(5, 10)})
	_, sides := processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 7})
	if len(sides) != 1 || sides[0].Reason != SideOutputNoWindow {
		t.Fatalf("unexpected side output: %+v", sides)
	}
}

func TestInvalidConfiguration(t *testing.T) {
	if _, err := NewOperator(Config{Window: Tumbling(0)}); err == nil {
		t.Fatal("expected invalid window error")
	}
	if _, err := NewOperator(Config{Window: Tumbling(10), AllowedLateness: -1}); err == nil {
		t.Fatal("expected invalid lateness error")
	}
}
