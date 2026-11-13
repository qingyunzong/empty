package dataeng

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func collectorPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "app.log")
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func appendFile(t *testing.T, path, content string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("open append %s: %v", path, err)
	}
	if _, err := file.WriteString(content); err != nil {
		file.Close()
		t.Fatalf("append %s: %v", path, err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close %s: %v", path, err)
	}
}

func newTestCollector(t *testing.T, path string, rule Rule, opts ...Option) *Collector {
	t.Helper()
	agg := NewAggregator(rule, opts...)
	collector, err := NewCollector(path, agg)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}
	return collector
}

func TestCollectorReadsLogicalLinesAndCarriesPartial(t *testing.T) {
	path := collectorPath(t)
	first := "2026-01-02 first"
	continuation := "  continuation"
	second := "2026-01-02 second"
	writeFile(t, path, first+"\n"+continuation+"\n"+second+"\n")

	collector := newTestCollector(t, path, timestampRule())
	events, err := collector.Poll()
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("Poll emitted %d events, want 1", len(events))
	}
	if events[0].Text() != first+"\n"+continuation {
		t.Errorf("event text = %q", events[0].Text())
	}
	firstEnd := int64(len(first) + 1 + len(continuation) + 1)
	if events[0].StartOffset != 0 || events[0].EndOffset != firstEnd {
		t.Errorf("event offsets = [%d,%d), want [0,%d)", events[0].StartOffset, events[0].EndOffset, firstEnd)
	}
	pending, ok := collector.agg.Current()
	if !ok || pending.Text() != second {
		t.Fatalf("pending = %+v, want second event", pending)
	}

	partial := "  partial tail"
	appendFile(t, path, partial)
	if events, err := collector.Poll(); err != nil || len(events) != 0 {
		t.Fatalf("Poll with partial = %v, %v; want no events and no error", events, err)
	}
	state := collector.Snapshot()
	if string(state.Partial) != partial {
		t.Errorf("snapshot partial = %q, want %q", state.Partial, partial)
	}
	if state.ReadOffset != int64(len(first)+1+len(continuation)+1+len(second)+1+len(partial)) {
		t.Errorf("snapshot read offset = %d", state.ReadOffset)
	}

	appendFile(t, path, " rest\n2026-01-02 third\n")
	events, err = collector.Poll()
	if err != nil {
		t.Fatalf("Poll after completion: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("Poll emitted %d events, want 1", len(events))
	}
	if events[0].Text() != second+"\n"+partial+" rest" {
		t.Errorf("completed partial text = %q", events[0].Text())
	}
	if events[0].StartOffset != firstEnd {
		t.Errorf("completed partial start offset = %d, want %d", events[0].StartOffset, firstEnd)
	}
}

func TestCollectorRotationDrainsOldFileAndAttachesReason(t *testing.T) {
	path := collectorPath(t)
	writeFile(t, path, "2026-01-02 first\n  continuation\n")

	collector := newTestCollector(t, path, timestampRule())
	if events, err := collector.Poll(); err != nil || len(events) != 0 {
		t.Fatalf("initial Poll = %v, %v; want no event", events, err)
	}

	rotated := path + ".1"
	if err := os.Rename(path, rotated); err != nil {
		t.Fatalf("rename: %v", err)
	}
	appendFile(t, rotated, "  written after rename\n")
	writeFile(t, path, "2026-01-02 second\n  next continuation\n")

	events, err := collector.Poll()
	if err != nil {
		t.Fatalf("Poll after rotation: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("rotation emitted %d events, want 1", len(events))
	}
	event := events[0]
	if event.Reason != ReasonRotation || !errors.Is(event.Err, ErrRotation) {
		t.Errorf("event = %+v, want rotation cause", event)
	}
	if want := "2026-01-02 first\n  continuation\n  written after rename"; event.Text() != want {
		t.Errorf("rotation text = %q, want %q", event.Text(), want)
	}
	pending, ok := collector.agg.Current()
	if !ok || pending.Text() != "2026-01-02 second\n  next continuation" {
		t.Fatalf("pending after rotation = %+v", pending)
	}
}

func TestCollectorTruncationTerminatesOpenEvent(t *testing.T) {
	path := collectorPath(t)
	old := "2026-01-02 first\n  continuation\n"
	writeFile(t, path, old)

	collector := newTestCollector(t, path, timestampRule())
	if events, err := collector.Poll(); err != nil || len(events) != 0 {
		t.Fatalf("initial Poll = %v, %v; want no event", events, err)
	}

	writeFile(t, path, "2026-x\n")
	events, err := collector.Poll()
	if err != nil {
		t.Fatalf("Poll after truncation: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("truncation emitted %d events, want 1", len(events))
	}
	if events[0].Reason != ReasonTruncation || !errors.Is(events[0].Err, ErrTruncation) {
		t.Errorf("event = %+v, want truncation cause", events[0])
	}
	if events[0].Text() != "2026-01-02 first\n  continuation" {
		t.Errorf("truncation text = %q", events[0].Text())
	}
	pending, ok := collector.agg.Current()
	if !ok || pending.Text() != "2026-x" {
		t.Fatalf("pending after truncation = %+v, want new line", pending)
	}
}

func TestCollectorReappearingSourceStartsAtZero(t *testing.T) {
	path := collectorPath(t)
	writeFile(t, path, "2026-01-02 old\n")

	collector := newTestCollector(t, path, timestampRule())
	if events, err := collector.Poll(); err != nil || len(events) != 0 {
		t.Fatalf("initial Poll = %v, %v; want no event", events, err)
	}

	if err := os.Remove(path); err != nil {
		t.Fatalf("remove source: %v", err)
	}
	events, err := collector.Poll()
	if err != nil {
		t.Fatalf("Poll after removal: %v", err)
	}
	if len(events) != 1 || events[0].Reason != ReasonRotation {
		t.Fatalf("removal events = %+v, want one rotation event", events)
	}

	// The replacement is longer than the old read offset. If the cursor were
	// not reset, its leading bytes would be skipped.
	replacement := "2026-01-02 replacement first line\n"
	writeFile(t, path, replacement)
	if events, err := collector.Poll(); err != nil || len(events) != 0 {
		t.Fatalf("Poll after re-create = %v, %v; want no event", events, err)
	}
	pending, ok := collector.agg.Current()
	if !ok || pending.Text() != "2026-01-02 replacement first line" {
		t.Fatalf("pending after re-create = %+v, want full replacement line", pending)
	}
	if pending.StartOffset != 0 {
		t.Errorf("replacement start offset = %d, want 0", pending.StartOffset)
	}
}

func TestCollectorSnapshotRestoresPartialLineAtOriginalOffset(t *testing.T) {
	path := collectorPath(t)
	first := "2026-01-02 first"
	partial := "  tail"
	writeFile(t, path, first+"\n"+partial)

	collector := newTestCollector(t, path, timestampRule())
	if events, err := collector.Poll(); err != nil || len(events) != 0 {
		t.Fatalf("initial Poll = %v, %v; want no event", events, err)
	}
	state := collector.Snapshot()
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	var decoded CollectorState
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}
	if decoded.Aggregator.Pending == nil {
		t.Fatal("decoded snapshot has no pending event")
	}
	if decoded.Aggregator.Pending.StartOffset != 0 {
		t.Errorf("decoded pending start = %d, want 0", decoded.Aggregator.Pending.StartOffset)
	}

	collector2 := newTestCollector(t, path, timestampRule())
	if err := collector2.Restore(decoded); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	appendFile(t, path, " rest\n2026-01-02 second\n")

	events, err := collector2.Poll()
	if err != nil {
		t.Fatalf("Poll after restore: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("restored Poll emitted %d events, want 1", len(events))
	}
	if want := first + "\n" + partial + " rest"; events[0].Text() != want {
		t.Errorf("restored event text = %q, want %q", events[0].Text(), want)
	}
	wantEnd := int64(len(first) + 1 + len(partial) + len(" rest") + 1)
	if events[0].StartOffset != 0 || events[0].EndOffset != wantEnd {
		t.Errorf("restored event offsets = [%d,%d), want [0,%d)", events[0].StartOffset, events[0].EndOffset, wantEnd)
	}
	pending, ok := collector2.agg.Current()
	if !ok || pending.Text() != "2026-01-02 second" {
		t.Fatalf("pending after restore = %+v", pending)
	}
}

func TestCollectorRestoreDetectsReplacementFile(t *testing.T) {
	path := collectorPath(t)
	writeFile(t, path, "2026-01-02 first\n  continuation")

	collector := newTestCollector(t, path, timestampRule())
	if events, err := collector.Poll(); err != nil || len(events) != 0 {
		t.Fatalf("initial Poll = %v, %v; want no event", events, err)
	}
	state := collector.Snapshot()

	replacement := path + ".new"
	writeFile(t, replacement, "2026-01-02 replacement\n")
	if err := os.Rename(replacement, path); err != nil {
		t.Fatalf("replace source: %v", err)
	}

	collector2 := newTestCollector(t, path, timestampRule())
	if err := collector2.Restore(state); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	events, err := collector2.Poll()
	if err != nil {
		t.Fatalf("Poll after replacement: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("replacement Poll emitted %d events, want 1", len(events))
	}
	if events[0].Reason != ReasonRotation || !errors.Is(events[0].Err, ErrRotation) {
		t.Errorf("event = %+v, want rotation cause", events[0])
	}
	if events[0].Text() != "2026-01-02 first" {
		t.Errorf("rotation text = %q, want restored pending line", events[0].Text())
	}
	pending, ok := collector2.agg.Current()
	if !ok || pending.Text() != "2026-01-02 replacement" {
		t.Fatalf("pending after replacement = %+v", pending)
	}
}

func TestCollectorMissingSourceAndClose(t *testing.T) {
	path := collectorPath(t)
	collector := newTestCollector(t, path, timestampRule())
	if _, err := collector.Poll(); !errors.Is(err, ErrSourceMissing) {
		t.Fatalf("Poll missing = %v, want ErrSourceMissing", err)
	}

	writeFile(t, path, "2026-01-02 first\n  partial")
	if events, err := collector.Poll(); err != nil || len(events) != 0 {
		t.Fatalf("Poll after create = %v, %v; want no event", events, err)
	}
	events := collector.Close()
	if len(events) != 1 {
		t.Fatalf("Close emitted %d events, want 1", len(events))
	}
	if events[0].Reason != ReasonFlush || events[0].Text() != "2026-01-02 first\n  partial" {
		t.Errorf("Close event = %+v", events[0])
	}
	if _, err := collector.Poll(); !errors.Is(err, ErrCollectorClosed) {
		t.Fatalf("Poll after Close = %v, want ErrCollectorClosed", err)
	}
}

func TestCollectorScheduledFlushRaceEmitsOnce(t *testing.T) {
	path := collectorPath(t)
	writeFile(t, path, "2026-01-02 old\n")

	const iterations = 200
	for i := 0; i < iterations; i++ {
		collector := newTestCollector(t, path, timestampRule(), WithClock(func() time.Time {
			return testEpoch
		}))
		if events, err := collector.Poll(); err != nil || len(events) != 0 {
			t.Fatalf("iteration %d initial Poll = %v, %v; want no event", i, events, err)
		}

		var (
			wg      sync.WaitGroup
			mu      sync.Mutex
			got     []Event
			start   = make(chan struct{})
			dueTime = testEpoch.Add(10 * time.Second)
		)
		collect := func(events []Event) {
			mu.Lock()
			got = append(got, events...)
			mu.Unlock()
		}
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			collect(collector.FlushDue(dueTime))
		}()
		go func() {
			defer wg.Done()
			<-start
			collect(collector.agg.PushAt(line("2026-01-02 new", 17), dueTime))
		}()
		close(start)
		wg.Wait()

		if len(got) != 1 || got[0].Reason != ReasonTimeout {
			t.Fatalf("iteration %d race result = %+v, want one timeout event", i, got)
		}
		pending, ok := collector.agg.Current()
		if !ok || pending.Text() != "2026-01-02 new" {
			t.Fatalf("iteration %d pending = %+v", i, pending)
		}
		collector.Close()
	}
}
