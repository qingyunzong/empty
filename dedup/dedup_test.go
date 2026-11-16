package dedup

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

var testCfg = Config{
	WindowSize:        time.Hour,
	WindowCount:       2,
	ExpectedPerWindow: 100,
	FalsePositiveRate: 0.01,
}

var base = time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)

func newTestDeduper(t *testing.T, cfg Config) (*Deduper, *MemIndex) {
	t.Helper()
	idx := NewMemIndex()
	d, err := New(cfg, idx)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return d, idx
}

func mustCheck(t *testing.T, d *Deduper, key string, ts time.Time) bool {
	t.Helper()
	dup, err := d.CheckAndAdd(context.Background(), key, ts)
	if err != nil {
		t.Fatalf("CheckAndAdd(%q): %v", key, err)
	}
	return dup
}

func TestExactSetDedup(t *testing.T) {
	d, idx := newTestDeduper(t, testCfg)
	if mustCheck(t, d, "a", base) {
		t.Fatal("first sight of key must be new")
	}
	if !mustCheck(t, d, "a", base.Add(time.Minute)) {
		t.Fatal("same key in active window must be duplicate")
	}
	if got := idx.HasCalls(); got != 0 {
		t.Fatalf("exact-set hits must not touch the index, got %d Has calls", got)
	}
}

func TestRotationOnlyOnWatermark(t *testing.T) {
	d, idx := newTestDeduper(t, testCfg)
	mustCheck(t, d, "a", base)
	// Simulate arbitrary processing delay and volume: without a watermark
	// advance nothing may be sealed or forgotten.
	for i := 0; i < 1000; i++ {
		mustCheck(t, d, fmt.Sprintf("filler-%d", i), base.Add(time.Minute))
	}
	if !mustCheck(t, d, "a", base.Add(2*time.Minute)) {
		t.Fatal("processing delay must not cause early forgetting")
	}
	if got := idx.HasCalls(); got != 0 {
		t.Fatalf("no rotation without watermark, expected 0 Has calls, got %d", got)
	}
	if s := d.Stats(); s.Layers != 0 {
		t.Fatalf("no watermark advance => no rotation, got %d layers", s.Layers)
	}
}

func TestRotationSealsWindow(t *testing.T) {
	d, _ := newTestDeduper(t, testCfg)
	mustCheck(t, d, "a", base)
	d.AdvanceWatermark(base.Add(time.Hour)) // seals [base, base+1h)
	if s := d.Stats(); s.Layers != 1 || s.ExactSize != 0 {
		t.Fatalf("after rotation want 1 layer and empty exact set, got %+v", s)
	}
	// Duplicate in the sealed window: Bloom suspicion confirmed by index.
	if !mustCheck(t, d, "a", base.Add(30*time.Minute)) {
		t.Fatal("key in sealed window must be duplicate")
	}
}

func TestLateEventRoutedToSealedWindow(t *testing.T) {
	d, _ := newTestDeduper(t, testCfg)
	mustCheck(t, d, "a", base)
	d.AdvanceWatermark(base.Add(time.Hour))
	// Brand-new key arriving late for the sealed window.
	if mustCheck(t, d, "late", base.Add(10*time.Minute)) {
		t.Fatal("late new key must be new")
	}
	// Its duplicate is caught via the sealed window's Bloom layer.
	if !mustCheck(t, d, "late", base.Add(20*time.Minute)) {
		t.Fatal("duplicate of late key must be detected")
	}
}

func TestBeyondRetentionUsesIndex(t *testing.T) {
	d, _ := newTestDeduper(t, testCfg)
	mustCheck(t, d, "old", base)
	// Rotate 3 windows with WindowCount=2: the first window is dropped.
	d.AdvanceWatermark(base.Add(3 * time.Hour))
	if s := d.Stats(); s.Layers != 2 {
		t.Fatalf("retention must cap layers at 2, got %d", s.Layers)
	}
	// A duplicate of the evicted key is still caught via the index.
	if !mustCheck(t, d, "old", base.Add(5*time.Minute)) {
		t.Fatal("duplicate beyond retention must be detected via index")
	}
	// A genuinely new key beyond retention is accepted and recorded.
	if mustCheck(t, d, "ancient-new", base.Add(6*time.Minute)) {
		t.Fatal("new key beyond retention must be new")
	}
	if !mustCheck(t, d, "ancient-new", base.Add(7*time.Minute)) {
		t.Fatal("replay of index-only key must be duplicate")
	}
}

// fpCfg saturates Bloom layers quickly to exercise the false-positive path.
var fpCfg = Config{
	WindowSize:        time.Hour,
	WindowCount:       2,
	ExpectedPerWindow: 1,
	FalsePositiveRate: 0.9,
}

func TestBloomFalsePositiveStillVerdictCorrect(t *testing.T) {
	d, idx := newTestDeduper(t, fpCfg)
	mustCheck(t, d, "x", base)
	mustCheck(t, d, "y", base)
	d.AdvanceWatermark(base.Add(time.Hour)) // seal saturated layer
	// Find a fresh key that the Bloom filter suspects (false positive).
	probe := ""
	for i := 0; ; i++ {
		candidate := fmt.Sprintf("probe-%d", i)
		if d.layers[0].filter.mayContain(candidate) {
			probe = candidate
			break
		}
	}
	before := idx.HasCalls()
	if mustCheck(t, d, probe, base.Add(30*time.Minute)) {
		t.Fatal("Bloom false positive must not flip the verdict to duplicate")
	}
	if idx.HasCalls() != before+1 {
		t.Fatalf("suspicion must be confirmed against the index exactly once, Has calls %d -> %d", before, idx.HasCalls())
	}
}

func TestCheckpointRestoreSameFalsePositivePath(t *testing.T) {
	d, idx := newTestDeduper(t, fpCfg)
	ctx := context.Background()
	mustCheck(t, d, "x", base)
	mustCheck(t, d, "y", base)
	d.AdvanceWatermark(base.Add(time.Hour))
	mustCheck(t, d, "z", base.Add(time.Hour)) // lands in active window
	snap, err := d.Snapshot(ctx)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if idx.Checkpoints() != 1 {
		t.Fatalf("Snapshot must flush a CheckpointableIndex, got %d checkpoints", idx.Checkpoints())
	}
	restored, err := Restore(snap, idx)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	// Bit-identical Bloom layers => identical suspicion set.
	for i := 0; i < 500; i++ {
		key := fmt.Sprintf("fp-probe-%d", i)
		before := d.layers[0].filter.mayContain(key)
		after := restored.layers[0].filter.mayContain(key)
		if before != after {
			t.Fatalf("false-positive path diverged after restore for %q", key)
		}
	}
	// No false negatives across recovery: every accepted key is still a dup.
	for _, key := range []string{"x", "y", "z"} {
		ts := base
		if key == "z" {
			ts = base.Add(time.Hour)
		}
		if !mustCheck(t, restored, key, ts.Add(time.Minute)) {
			t.Fatalf("restored Deduper forgot %q: false negative", key)
		}
	}
	// Watermark and window state survive: rotation continues seamlessly.
	if got := restored.Stats().Watermark; !got.Equal(base.Add(time.Hour)) {
		t.Fatalf("watermark not restored, got %v", got)
	}
	restored.AdvanceWatermark(base.Add(2 * time.Hour))
	if !mustCheck(t, restored, "z", base.Add(time.Hour).Add(time.Minute)) {
		t.Fatal("key sealed after restore must still be duplicate")
	}
}

func TestCheckpointRestoreNoFalseNegativesFuzz(t *testing.T) {
	d, idx := newTestDeduper(t, testCfg)
	ctx := context.Background()
	var accepted []string
	for w := 0; w < 4; w++ {
		for i := 0; i < 50; i++ {
			key := fmt.Sprintf("w%d-key%d", w, i)
			if mustCheck(t, d, key, base.Add(time.Duration(w)*time.Hour+time.Duration(i)*time.Second)) {
				t.Fatalf("%q reported duplicate on first sight", key)
			}
			accepted = append(accepted, key)
		}
		d.AdvanceWatermark(base.Add(time.Duration(w+1) * time.Hour))
	}
	snap, err := d.Snapshot(ctx)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	restored, err := Restore(snap, idx)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	for i, key := range accepted {
		w := i / 50
		ts := base.Add(time.Duration(w)*time.Hour + time.Duration(i%50)*time.Second)
		if !mustCheck(t, restored, key, ts) {
			t.Fatalf("false negative after restore for %q", key)
		}
	}
}

func TestFutureEventRejected(t *testing.T) {
	d, _ := newTestDeduper(t, testCfg)
	mustCheck(t, d, "a", base)
	_, err := d.CheckAndAdd(context.Background(), "future", base.Add(2*time.Hour))
	if !errors.Is(err, ErrEventAheadOfWatermark) {
		t.Fatalf("want ErrEventAheadOfWatermark, got %v", err)
	}
	d.AdvanceWatermark(base.Add(2 * time.Hour))
	if mustCheck(t, d, "future", base.Add(2*time.Hour)) {
		t.Fatal("after watermark advance the event must be accepted as new")
	}
}

func TestWatermarkMonotonic(t *testing.T) {
	d, _ := newTestDeduper(t, testCfg)
	mustCheck(t, d, "a", base)
	d.AdvanceWatermark(base.Add(time.Hour))
	d.AdvanceWatermark(base.Add(30 * time.Minute)) // regression: ignored
	if got := d.Stats().Watermark; !got.Equal(base.Add(time.Hour)) {
		t.Fatalf("watermark regressed to %v", got)
	}
	if s := d.Stats(); s.Layers != 1 {
		t.Fatalf("regressed watermark must not rotate further, got %d layers", s.Layers)
	}
}

func TestRestoreRejectsCorrupt(t *testing.T) {
	d, idx := newTestDeduper(t, testCfg)
	mustCheck(t, d, "a", base)
	snap, err := d.Snapshot(context.Background())
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	truncated := snap[:len(snap)/2]
	trailing := append(append([]byte(nil), snap...), 0x00)
	for _, bad := range [][]byte{nil, []byte("garbage"), truncated, trailing} {
		if _, err := Restore(bad, idx); err == nil {
			t.Fatalf("corrupt snapshot %q must be rejected", bad)
		}
	}
}

func TestConfigValidation(t *testing.T) {
	if _, err := New(Config{}, NewMemIndex()); err == nil {
		t.Fatal("zero config must be rejected")
	}
	if _, err := New(testCfg, nil); err == nil {
		t.Fatal("nil index must be rejected")
	}
}
