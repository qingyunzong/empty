package dataeng

import (
	"context"
	"errors"
	"testing"
)

func TestMemoryStore(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore()
	if _, err := store.Load(context.Background()); !errors.Is(err, ErrNoState) {
		t.Fatalf("Load() error = %v", err)
	}

	state := State{Watermark: MustParseLSN("0000002a:0000005c:0002")}
	if err := store.Save(context.Background(), state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	loaded, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !loaded.Watermark.Equal(state.Watermark) {
		t.Fatalf("Load() = %#v", loaded)
	}
}

func TestStateObserveAndComplete(t *testing.T) {
	t.Parallel()

	state := NewState()
	first := ChangeRow{
		StartLSN:  MustParseLSN("0000002a:0000005c:0001"),
		SeqVal:    MustParseLSN("0000002a:0000005c:0001"),
		Operation: OperationInsert,
	}
	if !state.Observe(first) {
		t.Fatal("Observe(first) = false")
	}
	if state.Observe(first) {
		t.Fatal("stale replay advanced the position")
	}
	state.CompleteThrough(first.StartLSN)
	if !state.Watermark.Equal(first.StartLSN) {
		t.Fatalf("Watermark = %s", state.Watermark)
	}
	older := MustParseLSN("0000002a:0000005c:0000")
	state.CompleteThrough(older)
	if !state.Watermark.Equal(first.StartLSN) {
		t.Fatal("watermark moved backwards")
	}
}

func TestStateResetToSnapshot(t *testing.T) {
	t.Parallel()

	snapshot := MustParseLSN("0000002a:0000005c:0004")
	state := State{Watermark: MustParseLSN("0000002a:0000005c:0001"), PendingSnapshot: true}
	state.ResetToSnapshot(snapshot)

	if state.NeedsSnapshot() {
		t.Fatal("snapshot flag was not cleared")
	}
	if !state.Watermark.Equal(snapshot) || !state.SnapshotLSN.Equal(snapshot) {
		t.Fatalf("state = %#v", state)
	}
	bounds := Bounds{MinLSN: snapshot, MaxLSN: MustParseLSN("0000002a:0000005c:0008")}
	plan, err := PlanNext(state, bounds)
	if err != nil {
		t.Fatalf("PlanNext() error = %v", err)
	}
	if got := plan.Range.FromLSN.String(); got != "0000002a:0000005c:0005" {
		t.Fatalf("FromLSN after snapshot = %s", got)
	}
}
