package dataeng

import (
	"bytes"
	"fmt"
	"reflect"
	"testing"
)

type snapshotStep struct {
	name string
	run  func(*Operator) ([]WindowResult, []SideOutput)
}

func summarizeResults(results []WindowResult) []string {
	out := make([]string, len(results))
	for i, r := range results {
		out[i] = fmt.Sprintf("%s/%s/%s/v%d/late=%v/n=%d/agg=%v",
			r.Partition, r.Key, r.Window, r.Version, r.Late, len(r.Events), r.Aggregate)
	}
	return out
}

func summarizeSides(sides []SideOutput) []string {
	out := make([]string, len(sides))
	for i, s := range sides {
		out[i] = fmt.Sprintf("%s/%s/%s/reason=%s", s.Event.Partition, s.Event.Key, windowsString(s.Windows), s.Reason)
	}
	return out
}

func runSteps(t *testing.T, op *Operator, steps []snapshotStep) ([]string, []string) {
	t.Helper()
	var results, sides []string
	for _, step := range steps {
		r, s := step.run(op)
		results = append(results, summarizeResults(r)...)
		sides = append(sides, summarizeSides(s)...)
	}
	return results, sides
}

func TestSnapshotRestoreSlidingOrderAndVersions(t *testing.T) {
	cfg := Config{
		Window:          Sliding(10, 5),
		AllowedLateness: 5,
		Aggregate: func(_ WindowContext, events []Event) any {
			return len(events)
		},
	}
	record := func(key string, ts int64, value string) func(*Operator) ([]WindowResult, []SideOutput) {
		return func(op *Operator) ([]WindowResult, []SideOutput) {
			return processEvent(t, op, Event{Partition: "p", Key: key, Timestamp: ts, Value: value})
		}
	}
	wm := func(source string, ts int64) func(*Operator) ([]WindowResult, []SideOutput) {
		return func(op *Operator) ([]WindowResult, []SideOutput) {
			return advance(t, op, "p", source, ts), nil
		}
	}

	prefix := []snapshotStep{
		{"a:1", record("a", 1, "a1")},
		{"b:7", record("b", 7, "b7")},
		{"wm10", wm("s1", 10)},
		{"a:5", record("a", 5, "a5")},
	}
	suffix := []snapshotStep{
		{"b:8", record("b", 8, "b8")},
		{"s2:15", wm("s2", 15)},
		{"b:9", record("b", 9, "b9")},
		{"s1:20", wm("s1", 20)},
		{"a:2", record("a", 2, "too-late")},
	}

	baselinePrefix, err := NewOperator(cfg)
	if err != nil {
		t.Fatal(err)
	}
	runSteps(t, baselinePrefix, prefix)
	wantResults, wantSides := runSteps(t, baselinePrefix, suffix)

	source, err := NewOperator(cfg)
	if err != nil {
		t.Fatal(err)
	}
	runSteps(t, source, prefix)
	snap1, err := source.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	snap2, err := source.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot again: %v", err)
	}
	if !bytes.Equal(snap1, snap2) {
		t.Fatal("repeated snapshots of identical state must be stable")
	}

	restored, err := NewOperator(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := restored.Restore(snap1); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	gotResults, gotSides := runSteps(t, restored, suffix)

	if !reflect.DeepEqual(gotResults, wantResults) {
		t.Fatalf("result sequence changed after restore:\n got: %v\nwant: %v", gotResults, wantResults)
	}
	if !reflect.DeepEqual(gotSides, wantSides) {
		t.Fatalf("side output changed after restore:\n got: %v\nwant: %v", gotSides, wantSides)
	}
}

func TestSnapshotRestoreSessionVersions(t *testing.T) {
	cfg := Config{
		Window:          Session(5),
		AllowedLateness: 10,
		Aggregate: func(_ WindowContext, events []Event) any {
			return len(events)
		},
	}
	record := func(key string, ts int64) func(*Operator) ([]WindowResult, []SideOutput) {
		return func(op *Operator) ([]WindowResult, []SideOutput) {
			return processEvent(t, op, Event{Partition: "p", Key: key, Timestamp: ts})
		}
	}
	wm := func(ts int64) func(*Operator) ([]WindowResult, []SideOutput) {
		return func(op *Operator) ([]WindowResult, []SideOutput) {
			return advance(t, op, "p", "s", ts), nil
		}
	}
	prefix := []snapshotStep{
		{"a1", record("a", 1)},
		{"a3", record("a", 3)},
		{"b2", record("b", 2)},
		{"wm8", wm(8)},
	}
	suffix := []snapshotStep{
		{"a2-late", record("a", 2)},
		{"a10", record("a", 10)},
		{"wm18", wm(18)},
		{"b3-too-late", record("b", 3)},
	}

	baselinePrefix, _ := NewOperator(cfg)
	runSteps(t, baselinePrefix, prefix)
	wantResults, wantSides := runSteps(t, baselinePrefix, suffix)

	source, _ := NewOperator(cfg)
	runSteps(t, source, prefix)
	snap, err := source.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	restored, _ := NewOperator(cfg)
	if err := restored.Restore(snap); err != nil {
		t.Fatal(err)
	}
	gotResults, gotSides := runSteps(t, restored, suffix)

	if !reflect.DeepEqual(gotResults, wantResults) {
		t.Fatalf("session result sequence changed after restore:\n got: %v\nwant: %v", gotResults, wantResults)
	}
	if !reflect.DeepEqual(gotSides, wantSides) {
		t.Fatalf("session side output changed after restore:\n got: %v\nwant: %v", gotSides, wantSides)
	}
}

type snapshotPayload struct {
	N int
}

func TestSnapshotRestoreCustomValue(t *testing.T) {
	RegisterEventValue(snapshotPayload{})
	cfg := Config{Window: Tumbling(10)}
	op, _ := NewOperator(cfg)
	processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 1, Value: snapshotPayload{N: 7}})

	snap, err := op.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	restored, _ := NewOperator(cfg)
	if err := restored.Restore(snap); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	results := advance(t, restored, "p", "s", 10)
	if len(results) != 1 {
		t.Fatalf("unexpected results: %v", results)
	}
	got, ok := results[0].Events[0].Value.(snapshotPayload)
	if !ok || got.N != 7 {
		t.Fatalf("value did not survive snapshot: %#v", results[0].Events[0].Value)
	}
}

func TestRestoreRejectsMismatchedConfiguration(t *testing.T) {
	op, _ := NewOperator(Config{Window: Tumbling(10)})
	snap, err := op.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	other, _ := NewOperator(Config{Window: Tumbling(20)})
	if err := other.Restore(snap); err == nil {
		t.Fatal("expected configuration mismatch")
	}
	if err := other.Restore([]byte("not a snapshot")); err == nil {
		t.Fatal("expected decode error")
	}
}

func TestSnapshotRestoreIdleSourceState(t *testing.T) {
	cfg := Config{Window: Tumbling(10)}
	op, _ := NewOperator(cfg)
	advance(t, op, "p", "a", 10)
	if _, err := op.MarkIdle("p", "b"); err != nil {
		t.Fatal(err)
	}
	snap, err := op.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	restored, _ := NewOperator(cfg)
	if err := restored.Restore(snap); err != nil {
		t.Fatal(err)
	}
	infos := restored.Sources("p")
	if len(infos) != 2 || infos[1].ID != "b" || !infos[1].Idle {
		t.Fatalf("idle state not restored: %+v", infos)
	}
	if wm, ok := restored.Watermark("p"); !ok || wm != 10 {
		t.Fatalf("watermark not restored: %d,%v", wm, ok)
	}
}
