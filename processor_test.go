package dataeng_test

import (
	"reflect"
	"testing"
	"time"

	dataeng "example.org/dataeng13/q0070"
)

var (
	t0   = time.Unix(0, 0).UTC()
	t1   = t0.Add(1 * time.Second)
	t2   = t0.Add(2 * time.Second)
	t3   = t0.Add(3 * time.Second)
	t4   = t0.Add(4 * time.Second)
	t5   = t0.Add(5 * time.Second)
	t6   = t0.Add(6 * time.Second)
	t9   = t0.Add(9 * time.Second)
	t10  = t0.Add(10 * time.Second)
	t15  = t0.Add(15 * time.Second)
	t20  = t0.Add(20 * time.Second)
	t100 = t0.Add(100 * time.Second)
	t500 = t0.Add(500 * time.Second)

	tick0 = time.Date(2024, time.January, 1, 0, 0, 0, 0, time.UTC)
	tick1 = tick0.Add(1 * time.Minute)
	tick2 = tick0.Add(2 * time.Minute)
	tick3 = tick0.Add(3 * time.Minute)
)

type manualClock struct {
	now time.Time
}

func (c *manualClock) Now() time.Time {
	return c.now
}

func (c *manualClock) set(t time.Time) {
	c.now = t
}

type steppingClock struct {
	next time.Time
	step time.Duration
}

func (c *steppingClock) Now() time.Time {
	at := c.next
	c.next = c.next.Add(c.step)
	return at
}

func mustProcessor(t *testing.T, opts dataeng.Options) *dataeng.Processor {
	t.Helper()
	p, err := dataeng.NewProcessor(opts)
	if err != nil {
		t.Fatalf("NewProcessor: %v", err)
	}
	return p
}

func assertOutputs(t *testing.T, got, want []dataeng.Output) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("outputs mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func applyResults(outputs []dataeng.Output, initial int64) int64 {
	aggregate := initial
	for _, out := range outputs {
		switch out.Kind {
		case dataeng.KindResult:
			aggregate = out.Value
		case dataeng.KindRetraction:
			aggregate -= out.Value
		}
	}
	return aggregate
}

func TestWindowClosesWhenWatermarkReachesEnd(t *testing.T) {
	clock := &manualClock{now: tick0}
	p := mustProcessor(t, dataeng.Options{
		WindowSize:      10 * time.Second,
		AllowedLateness: 3 * time.Second,
		Clock:           clock,
	})

	p.Process(dataeng.Event{Key: "k", Timestamp: t1, Value: 2})
	p.Process(dataeng.Event{Key: "k", Timestamp: t9, Value: 3})

	// One nanosecond before End is still open.
	assertOutputs(t, p.AdvanceWatermark(t9.Add(999*time.Millisecond)), nil)
	if got := p.Watermark(); !got.Equal(t9.Add(999 * time.Millisecond)) {
		t.Fatalf("watermark = %v", got)
	}

	// Reaching End closes the window exactly.
	got := p.AdvanceWatermark(t10)
	want := []dataeng.Output{{
		Kind:           dataeng.KindResult,
		Key:            "k",
		Window:         dataeng.Window{Start: t0, End: t10},
		Value:          5,
		Count:          2,
		Version:        1,
		Watermark:      t10,
		ProcessingTime: tick0,
	}}
	assertOutputs(t, got, want)
	if aggregate := applyResults(got, 0); aggregate != 5 {
		t.Fatalf("aggregate = %d, want 5", aggregate)
	}
}

func TestLateEventCorrectsWithinAllowedLatenessAndRetracts(t *testing.T) {
	clock := &manualClock{now: tick0}
	p := mustProcessor(t, dataeng.Options{
		WindowSize:      10 * time.Second,
		AllowedLateness: 5 * time.Second,
		Clock:           clock,
	})

	p.Process(dataeng.Event{Key: "k", Timestamp: t1, Value: 2})
	p.Process(dataeng.Event{Key: "k", Timestamp: t2, Value: 3})
	closed := p.AdvanceWatermark(t10)

	wantClosed := []dataeng.Output{{
		Kind:           dataeng.KindResult,
		Key:            "k",
		Window:         dataeng.Window{Start: t0, End: t10},
		Value:          5,
		Count:          2,
		Version:        1,
		Watermark:      t10,
		ProcessingTime: tick0,
	}}
	assertOutputs(t, closed, wantClosed)

	// A late event after close but before End+AllowedLateness corrects the
	// result. The old result is withdrawn first.
	clock.set(tick1)
	corrected := p.Process(dataeng.Event{Key: "k", Timestamp: t3, Value: 4})
	wantCorrected := []dataeng.Output{
		{
			Kind:           dataeng.KindRetraction,
			Key:            "k",
			Window:         dataeng.Window{Start: t0, End: t10},
			Value:          5,
			Count:          2,
			Version:        1,
			Watermark:      t10,
			ProcessingTime: tick1,
		},
		{
			Kind:           dataeng.KindResult,
			Key:            "k",
			Window:         dataeng.Window{Start: t0, End: t10},
			Value:          9,
			Count:          3,
			Version:        2,
			Watermark:      t10,
			ProcessingTime: tick1,
		},
	}
	assertOutputs(t, corrected, wantCorrected)
	if aggregate := applyResults(closed, 0); aggregate != 5 {
		t.Fatalf("aggregate after close = %d, want 5", aggregate)
	}
	if aggregate := applyResults(corrected, 5); aggregate != 9 {
		t.Fatalf("aggregate after correction = %d, want 9", aggregate)
	}

	// End+AllowedLateness is not reached yet at End+AllowedLateness-1ns.
	assertOutputs(t, p.AdvanceWatermark(t15.Add(-time.Nanosecond)), nil)
	clock.set(tick2)
	stillAccepted := p.Process(dataeng.Event{Key: "k", Timestamp: t5, Value: 1})
	wantStillAccepted := []dataeng.Output{
		{
			Kind:           dataeng.KindRetraction,
			Key:            "k",
			Window:         dataeng.Window{Start: t0, End: t10},
			Value:          9,
			Count:          3,
			Version:        2,
			Watermark:      t15.Add(-time.Nanosecond),
			ProcessingTime: tick2,
		},
		{
			Kind:           dataeng.KindResult,
			Key:            "k",
			Window:         dataeng.Window{Start: t0, End: t10},
			Value:          10,
			Count:          4,
			Version:        3,
			Watermark:      t15.Add(-time.Nanosecond),
			ProcessingTime: tick2,
		},
	}
	assertOutputs(t, stillAccepted, wantStillAccepted)

	// At End+AllowedLateness the window expires. The event only goes to the
	// side output and cannot change the aggregate.
	assertOutputs(t, p.AdvanceWatermark(t15), nil)
	clock.set(tick3)
	tooLate := p.Process(dataeng.Event{Key: "k", Timestamp: t6, Value: 7})
	wantTooLate := []dataeng.Output{{
		Kind:           dataeng.KindSideOutput,
		Key:            "k",
		Window:         dataeng.Window{Start: t0, End: t10},
		Event:          dataeng.Event{Key: "k", Timestamp: t6, Value: 7},
		Watermark:      t15,
		Reason:         dataeng.ReasonPastAllowedLateness,
		ProcessingTime: tick3,
	}}
	assertOutputs(t, tooLate, wantTooLate)

	if aggregate := applyResults(tooLate, 10); aggregate != 10 {
		t.Fatalf("aggregate after side output = %d, want 10", aggregate)
	}

	// A watermark beyond the deadline still only side-outputs the event.
	assertOutputs(t, p.AdvanceWatermark(t20), nil)
	evenLater := p.Process(dataeng.Event{Key: "k", Timestamp: t6, Value: 8})
	wantEvenLater := []dataeng.Output{{
		Kind:           dataeng.KindSideOutput,
		Key:            "k",
		Window:         dataeng.Window{Start: t0, End: t10},
		Event:          dataeng.Event{Key: "k", Timestamp: t6, Value: 8},
		Watermark:      t20,
		Reason:         dataeng.ReasonPastAllowedLateness,
		ProcessingTime: tick3,
	}}
	assertOutputs(t, evenLater, wantEvenLater)
}

func TestAllowedLatenessZeroSendsEveryPostCloseEventToSideOutput(t *testing.T) {
	clock := &manualClock{now: tick0}
	p := mustProcessor(t, dataeng.Options{
		WindowSize:      10 * time.Second,
		AllowedLateness: 0,
		Clock:           clock,
	})

	p.Process(dataeng.Event{Key: "k", Timestamp: t1, Value: 2})
	closed := p.AdvanceWatermark(t10)
	wantClosed := []dataeng.Output{{
		Kind:           dataeng.KindResult,
		Key:            "k",
		Window:         dataeng.Window{Start: t0, End: t10},
		Value:          2,
		Count:          1,
		Version:        1,
		Watermark:      t10,
		ProcessingTime: tick0,
	}}
	assertOutputs(t, closed, wantClosed)

	clock.set(tick1)
	aggregate := int64(2)
	for _, ev := range []dataeng.Event{
		{Key: "k", Timestamp: t2, Value: 5},
		{Key: "k", Timestamp: t9, Value: 6},
	} {
		got := p.Process(ev)
		want := []dataeng.Output{{
			Kind:           dataeng.KindSideOutput,
			Key:            ev.Key,
			Window:         dataeng.Window{Start: t0, End: t10},
			Event:          ev,
			Watermark:      t10,
			Reason:         dataeng.ReasonPastAllowedLateness,
			ProcessingTime: tick1,
		}}
		assertOutputs(t, got, want)
		aggregate = applyResults(got, aggregate)
	}

	if aggregate != 2 {
		t.Fatalf("aggregate = %d, want 2", aggregate)
	}
}

func TestEventAtEndBelongsToNextWindow(t *testing.T) {
	clock := &manualClock{now: tick0}
	p := mustProcessor(t, dataeng.Options{
		WindowSize:      10 * time.Second,
		AllowedLateness: 5 * time.Second,
		Clock:           clock,
	})

	// 9.999s belongs to [0,10); exactly 10s belongs to [10,20).
	p.Process(dataeng.Event{Key: "left", Timestamp: t9.Add(999 * time.Millisecond), Value: 7})
	p.Process(dataeng.Event{Key: "right", Timestamp: t10, Value: 1})

	got := p.AdvanceWatermark(t10)
	want := []dataeng.Output{{
		Kind:           dataeng.KindResult,
		Key:            "left",
		Window:         dataeng.Window{Start: t0, End: t10},
		Value:          7,
		Count:          1,
		Version:        1,
		Watermark:      t10,
		ProcessingTime: tick0,
	}}
	assertOutputs(t, got, want)

	p.Process(dataeng.Event{Key: "right", Timestamp: t20.Add(-time.Nanosecond), Value: 2})
	got = p.AdvanceWatermark(t20)
	want = []dataeng.Output{{
		Kind:           dataeng.KindResult,
		Key:            "right",
		Window:         dataeng.Window{Start: t10, End: t20},
		Value:          3,
		Count:          2,
		Version:        1,
		Watermark:      t20,
		ProcessingTime: tick0,
	}}
	assertOutputs(t, got, want)
}

func TestProcessingEventsNeverAdvancesWatermark(t *testing.T) {
	clock := &manualClock{now: tick0}
	p := mustProcessor(t, dataeng.Options{
		WindowSize:      10 * time.Second,
		AllowedLateness: 5 * time.Second,
		Clock:           clock,
	})

	if p.HasWatermark() {
		t.Fatal("processor has a watermark before one was supplied")
	}
	if !p.Watermark().IsZero() {
		t.Fatalf("initial watermark = %v, want zero", p.Watermark())
	}

	// A future event must not move the watermark.
	p.Process(dataeng.Event{Key: "k", Timestamp: t0.Add(time.Hour), Value: 1})
	if p.HasWatermark() {
		t.Fatal("processing an event created a watermark")
	}

	// The supplied watermark is adopted exactly, not boosted by event time.
	p.AdvanceWatermark(t100)
	p.Process(dataeng.Event{Key: "k", Timestamp: t0.Add(495 * time.Second), Value: 3})
	if got := p.Watermark(); !got.Equal(t100) {
		t.Fatalf("watermark after event = %v, want %v", got, t100)
	}

	// Backward or equal watermarks are ignored.
	p.AdvanceWatermark(t0.Add(50 * time.Second))
	p.AdvanceWatermark(t100)
	if got := p.Watermark(); !got.Equal(t100) {
		t.Fatalf("watermark after ignored updates = %v, want %v", got, t100)
	}

	// The open [490s,500s) window closes only at 500s.
	got := p.AdvanceWatermark(t500)
	want := []dataeng.Output{{
		Kind:           dataeng.KindResult,
		Key:            "k",
		Window:         dataeng.Window{Start: t0.Add(490 * time.Second), End: t500},
		Value:          3,
		Count:          1,
		Version:        1,
		Watermark:      t500,
		ProcessingTime: tick0,
	}}
	assertOutputs(t, got, want)

	p.Process(dataeng.Event{Key: "k", Timestamp: t0.Add(1000 * time.Second), Value: 9})
	if got := p.Watermark(); !got.Equal(t500) {
		t.Fatalf("watermark after future event = %v, want %v", got, t500)
	}
}

func TestClockStampsResultRetractionAndSideOutput(t *testing.T) {
	clock := &manualClock{now: tick0}
	p := mustProcessor(t, dataeng.Options{
		WindowSize:      10 * time.Second,
		AllowedLateness: 5 * time.Second,
		Clock:           clock,
	})

	p.Process(dataeng.Event{Key: "k", Timestamp: t1, Value: 2})
	clock.set(tick1)
	closed := p.AdvanceWatermark(t10)
	if len(closed) != 1 || !closed[0].ProcessingTime.Equal(tick1) {
		t.Fatalf("closed output processing time = %#v, want %v", closed, tick1)
	}

	clock.set(tick2)
	corrected := p.Process(dataeng.Event{Key: "k", Timestamp: t2, Value: 1})
	if len(corrected) != 2 {
		t.Fatalf("correction outputs = %#v", corrected)
	}
	for i, out := range corrected {
		if !out.ProcessingTime.Equal(tick2) {
			t.Fatalf("correction output %d processing time = %v, want %v", i, out.ProcessingTime, tick2)
		}
	}

	p.AdvanceWatermark(t15)
	clock.set(tick3)
	side := p.Process(dataeng.Event{Key: "k", Timestamp: t3, Value: 4})
	if len(side) != 1 || !side[0].ProcessingTime.Equal(tick3) {
		t.Fatalf("side output processing time = %#v, want %v", side, tick3)
	}
}

func TestCorrectionPairSharesOneProcessingTimestamp(t *testing.T) {
	clock := &steppingClock{next: tick0, step: time.Minute}
	p := mustProcessor(t, dataeng.Options{
		WindowSize:      10 * time.Second,
		AllowedLateness: 5 * time.Second,
		Clock:           clock,
	})

	p.Process(dataeng.Event{Key: "k", Timestamp: t1, Value: 2})
	p.Process(dataeng.Event{Key: "k", Timestamp: t2, Value: 3})
	closed := p.AdvanceWatermark(t10)
	if len(closed) != 1 || !closed[0].ProcessingTime.Equal(tick0) {
		t.Fatalf("closed output processing time = %#v, want %v", closed, tick0)
	}

	corrected := p.Process(dataeng.Event{Key: "k", Timestamp: t3, Value: 4})
	if len(corrected) != 2 {
		t.Fatalf("correction outputs = %#v", corrected)
	}
	if !corrected[0].ProcessingTime.Equal(tick1) || !corrected[1].ProcessingTime.Equal(tick1) {
		t.Fatalf("correction processing times = %v and %v, want both %v",
			corrected[0].ProcessingTime, corrected[1].ProcessingTime, tick1)
	}
}

func TestKeysAreIndependentWithinSameWindow(t *testing.T) {
	clock := &manualClock{now: tick0}
	p := mustProcessor(t, dataeng.Options{
		WindowSize:      10 * time.Second,
		AllowedLateness: 5 * time.Second,
		Clock:           clock,
	})

	p.Process(dataeng.Event{Key: "b", Timestamp: t1, Value: 3})
	p.Process(dataeng.Event{Key: "a", Timestamp: t2, Value: 2})
	p.Process(dataeng.Event{Key: "b", Timestamp: t5, Value: 5})
	p.Process(dataeng.Event{Key: "a", Timestamp: t6, Value: 4})

	got := p.AdvanceWatermark(t10)
	want := []dataeng.Output{
		{
			Kind:           dataeng.KindResult,
			Key:            "a",
			Window:         dataeng.Window{Start: t0, End: t10},
			Value:          6,
			Count:          2,
			Version:        1,
			Watermark:      t10,
			ProcessingTime: tick0,
		},
		{
			Kind:           dataeng.KindResult,
			Key:            "b",
			Window:         dataeng.Window{Start: t0, End: t10},
			Value:          8,
			Count:          2,
			Version:        1,
			Watermark:      t10,
			ProcessingTime: tick0,
		},
	}
	assertOutputs(t, got, want)
}

func TestLateEventForWindowWithoutPriorResultDoesNotRetract(t *testing.T) {
	clock := &manualClock{now: tick0}
	p := mustProcessor(t, dataeng.Options{
		WindowSize:      10 * time.Second,
		AllowedLateness: 5 * time.Second,
		Clock:           clock,
	})

	// Jump past End but stay before End+AllowedLateness. No window state
	// existed at close time, so the first result must not be a retraction.
	assertOutputs(t, p.AdvanceWatermark(t0.Add(12*time.Second)), nil)
	clock.set(tick1)
	got := p.Process(dataeng.Event{Key: "k", Timestamp: t1, Value: 4})
	want := []dataeng.Output{{
		Kind:           dataeng.KindResult,
		Key:            "k",
		Window:         dataeng.Window{Start: t0, End: t10},
		Value:          4,
		Count:          1,
		Version:        1,
		Watermark:      t0.Add(12 * time.Second),
		ProcessingTime: tick1,
	}}
	assertOutputs(t, got, want)
}

func TestEmptyWindowsDoNotEmit(t *testing.T) {
	clock := &manualClock{now: tick0}
	p := mustProcessor(t, dataeng.Options{
		WindowSize:      10 * time.Second,
		AllowedLateness: 5 * time.Second,
		Clock:           clock,
	})

	assertOutputs(t, p.AdvanceWatermark(t10), nil)
	assertOutputs(t, p.AdvanceWatermark(t100), nil)
}

func TestNewProcessorRejectsInvalidOptions(t *testing.T) {
	if _, err := dataeng.NewProcessor(dataeng.Options{WindowSize: 0}); err == nil {
		t.Fatal("expected error for zero window size")
	}
	if _, err := dataeng.NewProcessor(dataeng.Options{
		WindowSize:      10 * time.Second,
		AllowedLateness: -time.Second,
	}); err == nil {
		t.Fatal("expected error for negative allowed lateness")
	}
}

func TestWindowContainsIsHalfOpen(t *testing.T) {
	w := dataeng.Window{Start: t0, End: t10}
	if !w.Contains(t0) {
		t.Fatal("window must contain Start")
	}
	if w.Contains(t10) {
		t.Fatal("window must not contain End")
	}
	if got := w.Duration(); got != 10*time.Second {
		t.Fatalf("Duration = %v, want 10s", got)
	}
}
