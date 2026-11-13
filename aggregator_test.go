package dataeng

import (
	"errors"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

var testEpoch = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

func timestampRule() Rule {
	return Rule{
		Start:    HasPrefix("2026-"),
		Continue: HasPrefix(" ", "\t"),
		Timeout:  IdleTimeout(10 * time.Second),
	}
}

func line(text string, start int64) Line {
	return Line{Text: []byte(text), StartOffset: start, EndOffset: start + int64(len(text)) + 1}
}

func TestAggregatorStartContinueAndOffsets(t *testing.T) {
	agg := NewAggregator(timestampRule())

	if events := agg.PushAt(line("2026-01-02 first", 0), testEpoch); len(events) != 0 {
		t.Fatalf("first line emitted %d events, want 0", len(events))
	}
	if events := agg.PushAt(line("  at main.go:10", 17), testEpoch.Add(time.Second)); len(events) != 0 {
		t.Fatalf("continuation emitted %d events, want 0", len(events))
	}

	events := agg.PushAt(line("2026-01-02 second", 33), testEpoch.Add(2*time.Second))
	if len(events) != 1 {
		t.Fatalf("new start emitted %d events, want 1", len(events))
	}
	event := events[0]
	if event.Reason != ReasonNewStart {
		t.Errorf("reason = %q, want %q", event.Reason, ReasonNewStart)
	}
	if got, want := event.Text(), "2026-01-02 first\n  at main.go:10"; got != want {
		t.Errorf("text = %q, want %q", got, want)
	}
	if event.StartOffset != 0 || event.EndOffset != 33 {
		t.Errorf("offsets = [%d,%d), want [0,33)", event.StartOffset, event.EndOffset)
	}
	if event.Seq != 1 {
		t.Errorf("seq = %d, want 1", event.Seq)
	}

	pending, ok := agg.Current()
	if !ok {
		t.Fatal("second event is not pending")
	}
	if pending.StartOffset != 33 {
		t.Errorf("pending start offset = %d, want 33", pending.StartOffset)
	}
}

func TestAggregatorUnmatchedLineIsABoundary(t *testing.T) {
	agg := NewAggregator(Rule{
		Start:    HasPrefix("START"),
		Continue: HasPrefix(" "),
	})
	agg.PushAt(line("START one", 0), testEpoch)

	events := agg.PushAt(line("orphan", 10), testEpoch)
	if len(events) != 1 || events[0].Reason != ReasonNewStart {
		t.Fatalf("events = %+v, want one new-start boundary", events)
	}
	pending, ok := agg.Current()
	if !ok || pending.Text() != "orphan" {
		t.Fatalf("pending = %+v, want orphan event", pending)
	}
}

func TestAggregatorTimeout(t *testing.T) {
	agg := NewAggregator(timestampRule())
	agg.PushAt(line("2026-01-02 first", 0), testEpoch)

	if events := agg.FlushDue(testEpoch.Add(9 * time.Second)); len(events) != 0 {
		t.Fatalf("event timed out too early: %+v", events)
	}
	events := agg.FlushDue(testEpoch.Add(10 * time.Second))
	if len(events) != 1 {
		t.Fatalf("timeout emitted %d events, want 1", len(events))
	}
	if events[0].Reason != ReasonTimeout {
		t.Errorf("reason = %q, want %q", events[0].Reason, ReasonTimeout)
	}
	if _, ok := agg.Current(); ok {
		t.Error("event still pending after timeout")
	}

	agg.PushAt(line("2026-01-02 second", 17), testEpoch.Add(20*time.Second))
	events = agg.PushAt(line("  continuation", 35), testEpoch.Add(31*time.Second))
	if len(events) != 1 || events[0].Reason != ReasonTimeout {
		t.Fatalf("push after idle = %+v, want prior event timeout", events)
	}
	pending, ok := agg.Current()
	if !ok || pending.Text() != "  continuation" {
		t.Fatalf("pending = %+v, want continuation promoted to a new event", pending)
	}
}

func TestAggregatorMaxBytesSplitsEvents(t *testing.T) {
	agg := NewAggregator(Rule{Start: HasPrefix("START"), Continue: HasPrefix(" ")}, WithMaxEventBytes(20))
	agg.PushAt(line("START 0123456789", 0), testEpoch)
	agg.PushAt(line(" ab", 17), testEpoch)

	events := agg.PushAt(line(" 0123456789", 21), testEpoch)
	if len(events) != 1 {
		t.Fatalf("budget emitted %d events, want 1", len(events))
	}
	if events[0].Reason != ReasonMaxBytes || !errors.Is(events[0].Err, ErrMaxBytes) {
		t.Errorf("event = %+v, want max-bytes cause", events[0])
	}
	if events[0].Text() != "START 0123456789\n ab" {
		t.Errorf("event text = %q", events[0].Text())
	}

	pending, ok := agg.Current()
	if !ok || pending.Text() != " 0123456789" {
		t.Fatalf("pending = %+v, want overflow line in a new event", pending)
	}
}

func TestAggregatorMaxBytesTruncatesSingleLine(t *testing.T) {
	agg := NewAggregator(Rule{}, WithMaxEventBytes(20))
	events := agg.PushAt(line("012345678901234567890123456789", 0), testEpoch)
	if len(events) != 1 {
		t.Fatalf("oversized line emitted %d events, want 1", len(events))
	}
	event := events[0]
	if event.Reason != ReasonMaxBytes || !event.Truncated || !errors.Is(event.Err, ErrMaxBytes) {
		t.Errorf("event = %+v, want truncated max-bytes event", event)
	}
	if event.Bytes() != 20 {
		t.Errorf("event size = %d, want 20", event.Bytes())
	}
	if _, ok := agg.Current(); ok {
		t.Error("truncated event is still pending")
	}

	utf8Agg := NewAggregator(Rule{}, WithMaxEventBytes(21))
	events = utf8Agg.PushAt(line("ééééééééééé", 0), testEpoch)
	if len(events) != 1 {
		t.Fatalf("utf8 line emitted %d events, want 1", len(events))
	}
	if !utf8.ValidString(events[0].Text()) || events[0].Bytes() > 21 {
		t.Errorf("truncated text is invalid or too large: %q (%d bytes)", events[0].Text(), events[0].Bytes())
	}
}

func TestAggregatorEncodingErrorTerminatesEvent(t *testing.T) {
	agg := NewAggregator(timestampRule())
	agg.PushAt(line("2026-01-02 first", 0), testEpoch)

	events := agg.PushAt(Line{Text: []byte{' ', 0xff, 'x'}, StartOffset: 18, EndOffset: 21}, testEpoch)
	if len(events) != 1 {
		t.Fatalf("encoding error emitted %d events, want 1", len(events))
	}
	if events[0].Reason != ReasonEncoding || !errors.Is(events[0].Err, ErrEncoding) {
		t.Errorf("event = %+v, want encoding cause", events[0])
	}
	if events[0].Text() != "2026-01-02 first" {
		t.Errorf("event text = %q, want only decodable lines", events[0].Text())
	}
	if _, ok := agg.Current(); ok {
		t.Error("invalid line remained in an event")
	}
}

func TestFlushRaceWithNewStartEmitsOnce(t *testing.T) {
	const iterations = 500
	rule := timestampRule()

	for i := 0; i < iterations; i++ {
		agg := NewAggregator(rule)
		agg.PushAt(line("2026-01-02 old", 0), testEpoch)

		var (
			wg      sync.WaitGroup
			mu      sync.Mutex
			events  []Event
			start   = make(chan struct{})
			dueTime = testEpoch.Add(10 * time.Second)
		)
		collect := func(got []Event) {
			mu.Lock()
			events = append(events, got...)
			mu.Unlock()
		}

		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			collect(agg.FlushDue(dueTime))
		}()
		go func() {
			defer wg.Done()
			<-start
			collect(agg.PushAt(line("2026-01-02 new", 18), dueTime))
		}()
		close(start)
		wg.Wait()

		if len(events) != 1 {
			t.Fatalf("iteration %d emitted %d events, want exactly 1: %+v", i, len(events), events)
		}
		if events[0].Text() != "2026-01-02 old" || events[0].Reason != ReasonTimeout {
			t.Fatalf("iteration %d emitted %+v, want timed-out old event", i, events[0])
		}
		if events[0].Seq != 1 {
			t.Fatalf("iteration %d seq = %d, want 1", i, events[0].Seq)
		}
		pending, ok := agg.Current()
		if !ok || pending.Text() != "2026-01-02 new" {
			t.Fatalf("iteration %d pending = %+v, want new event", i, pending)
		}
	}
}

func TestAggregatorSnapshotRestoresPendingEvent(t *testing.T) {
	agg := NewAggregator(timestampRule())
	agg.PushAt(line("2026-01-02 first", 0), testEpoch)
	agg.PushAt(line("  continuation", 17), testEpoch.Add(time.Second))

	snapshot := agg.Snapshot()
	if snapshot.Pending == nil {
		t.Fatal("snapshot has no pending event")
	}
	if snapshot.Pending.StartOffset != 0 || snapshot.Pending.EndOffset != 32 {
		t.Fatalf("pending offsets = [%d,%d), want [0,32)", snapshot.Pending.StartOffset, snapshot.Pending.EndOffset)
	}

	restored := NewAggregator(timestampRule())
	if err := restored.Restore(snapshot); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	pending, ok := restored.Current()
	if !ok {
		t.Fatal("restored aggregator has no pending event")
	}
	if pending.Text() != "2026-01-02 first\n  continuation" {
		t.Errorf("restored text = %q", pending.Text())
	}
	if pending.StartOffset != 0 || pending.EndOffset != 32 {
		t.Errorf("restored offsets = [%d,%d), want [0,32)", pending.StartOffset, pending.EndOffset)
	}

	events := restored.PushAt(line("2026-01-02 second", 32), testEpoch.Add(2*time.Second))
	if len(events) != 1 {
		t.Fatalf("restored new start emitted %d events, want 1", len(events))
	}
	if events[0].StartOffset != 0 || events[0].EndOffset != 32 {
		t.Errorf("restored event offsets = [%d,%d), want [0,32)", events[0].StartOffset, events[0].EndOffset)
	}
	if events[0].Seq != 1 {
		t.Errorf("restored event seq = %d, want 1", events[0].Seq)
	}
}
