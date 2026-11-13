package dataeng

import (
	"sync"
	"testing"
	"time"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	return c.now
}

func traceID(b byte) TraceID {
	var id TraceID
	id[15] = b
	return id
}

func spanID(b byte) SpanID {
	var id SpanID
	id[7] = b
	return id
}

func makeSpan(trace TraceID, id, parent SpanID, name string) Span {
	return Span{
		TraceID:      trace,
		SpanID:       id,
		ParentSpanID: parent,
		Name:         name,
		Kind:         "server",
		Start:        time.Unix(1700000000, 0),
		End:          time.Unix(1700000001, 0),
		Attributes:   map[string]string{"http.method": "GET"},
		Resource:     Resource{Attributes: map[string]string{"service.name": "checkout"}},
		Scope:        Scope{Name: "otel/sdk", Version: "1.0"},
	}
}

func newTestAssembler(timeout time.Duration) (*Assembler, *fakeClock) {
	clock := &fakeClock{now: time.Unix(1700000100, 0)}
	return New(Options{PublishTimeout: timeout, Now: clock.Now}), clock
}

func TestOutOfOrderSpansMergeIntoOneSnapshot(t *testing.T) {
	a, clock := newTestAssembler(time.Minute)
	tid := traceID(1)
	root := makeSpan(tid, spanID(1), SpanID{}, "root")
	child := makeSpan(tid, spanID(2), spanID(1), "child")
	grandchild := makeSpan(tid, spanID(3), spanID(2), "grandchild")

	// Arrive out of order: grandchild and child before the root.
	for _, s := range []Span{grandchild, child, root} {
		if evs := a.Add(s); len(evs) != 0 {
			t.Fatalf("Add before publish returned %d events, want 0", len(evs))
		}
	}

	// Not yet due: no snapshot.
	if evs := a.FlushExpired(clock.Advance(30 * time.Second)); len(evs) != 0 {
		t.Fatalf("FlushExpired before deadline returned %d events, want 0", len(evs))
	}

	evs := a.FlushExpired(clock.Advance(31 * time.Second))
	if len(evs) != 1 {
		t.Fatalf("FlushExpired returned %d events, want 1", len(evs))
	}
	ev := evs[0]
	if ev.Kind != EventSnapshot || ev.Version != 1 || ev.TraceID != tid {
		t.Fatalf("unexpected event header: kind=%v version=%d trace=%v", ev.Kind, ev.Version, ev.TraceID)
	}
	if len(ev.Spans) != 3 {
		t.Fatalf("snapshot has %d spans, want 3", len(ev.Spans))
	}
	if len(ev.Orphans) != 0 {
		t.Fatalf("snapshot has %d orphan causes, want 0 (parent arrived in time)", len(ev.Orphans))
	}
	if got := ev.Spans[0].Name; got != "grandchild" {
		t.Fatalf("first span = %q, want insertion order (grandchild)", got)
	}
}

func TestMissingParentPublishesOnTimeoutWithRootCause(t *testing.T) {
	a, clock := newTestAssembler(10 * time.Second)
	tid := traceID(2)
	orphan := makeSpan(tid, spanID(9), spanID(99), "orphan")

	a.Add(orphan)
	evs := a.FlushExpired(clock.Advance(11 * time.Second))
	if len(evs) != 1 {
		t.Fatalf("FlushExpired returned %d events, want 1 (timeout must not block)", len(evs))
	}
	ev := evs[0]
	if ev.Kind != EventSnapshot {
		t.Fatalf("kind = %v, want snapshot", ev.Kind)
	}
	if len(ev.Orphans) != 1 {
		t.Fatalf("snapshot has %d orphan causes, want 1", len(ev.Orphans))
	}
	cause := ev.Orphans[0]
	if cause.MissingParent != spanID(99) {
		t.Fatalf("missing parent = %v, want %v", cause.MissingParent, spanID(99))
	}
	if len(cause.OrphanSpans) != 1 || cause.OrphanSpans[0] != spanID(9) {
		t.Fatalf("orphan spans = %v, want [%v]", cause.OrphanSpans, spanID(9))
	}
	if cause.Waited < 11*time.Second {
		t.Fatalf("waited = %v, want >= 11s", cause.Waited)
	}
}

func TestLateParentEmitsRevisionNotSnapshot(t *testing.T) {
	a, clock := newTestAssembler(10 * time.Second)
	tid := traceID(3)
	orphan := makeSpan(tid, spanID(9), spanID(99), "orphan")
	parent := makeSpan(tid, spanID(99), SpanID{}, "late-parent")

	a.Add(orphan)
	if evs := a.FlushExpired(clock.Advance(11 * time.Second)); len(evs) != 1 {
		t.Fatalf("expected snapshot after timeout, got %d events", len(evs))
	}

	// Late parent arrives: expect one incremental revision, not a resend.
	evs := a.Add(parent)
	if len(evs) != 1 {
		t.Fatalf("Add(late parent) returned %d events, want 1", len(evs))
	}
	ev := evs[0]
	if ev.Kind != EventRevision {
		t.Fatalf("kind = %v, want revision", ev.Kind)
	}
	if ev.Version != 2 {
		t.Fatalf("version = %d, want 2", ev.Version)
	}
	if len(ev.Spans) != 1 || ev.Spans[0].SpanID != spanID(99) {
		t.Fatalf("revision carries %d spans, want only the late parent", len(ev.Spans))
	}
	if len(ev.ResolvedOrphans) != 1 || ev.ResolvedOrphans[0] != spanID(9) {
		t.Fatalf("resolved orphans = %v, want [%v]", ev.ResolvedOrphans, spanID(9))
	}

	// A second late span bumps the version again.
	extra := makeSpan(tid, spanID(10), spanID(99), "sibling")
	evs = a.Add(extra)
	if len(evs) != 1 || evs[0].Version != 3 {
		t.Fatalf("second revision version = %v, want 3", evs)
	}
}

func TestConflictingSpanIDIsIsolated(t *testing.T) {
	a, clock := newTestAssembler(10 * time.Second)
	tid := traceID(4)
	original := makeSpan(tid, spanID(5), SpanID{}, "original")

	a.Add(original)

	// Exact duplicate: silently dropped.
	if evs := a.Add(original); len(evs) != 0 {
		t.Fatalf("duplicate delivery returned %d events, want 0", len(evs))
	}

	// Same span ID, different content: isolated as a conflict.
	conflicting := original
	conflicting.Name = "tampered"
	conflicting.Attributes = map[string]string{"http.method": "POST"}
	if evs := a.Add(conflicting); len(evs) != 0 {
		t.Fatalf("conflict before publish returned %d events, want 0", len(evs))
	}

	evs := a.FlushExpired(clock.Advance(11 * time.Second))
	if len(evs) != 1 {
		t.Fatalf("FlushExpired returned %d events, want 1", len(evs))
	}
	ev := evs[0]
	if len(ev.Spans) != 1 {
		t.Fatalf("snapshot has %d spans, want 1 (conflict must not merge)", len(ev.Spans))
	}
	if ev.Spans[0].Name != "original" {
		t.Fatalf("kept span name = %q, want %q", ev.Spans[0].Name, "original")
	}
	if len(ev.Conflicts) != 1 {
		t.Fatalf("snapshot has %d conflicts, want 1", len(ev.Conflicts))
	}
	c := ev.Conflicts[0]
	if c.SpanID != spanID(5) || c.Rejected.Name != "tampered" || c.Kept.Name != "original" {
		t.Fatalf("unexpected conflict record: %+v", c)
	}

	// A conflict arriving after publication surfaces as a revision.
	conflicting2 := original
	conflicting2.Kind = "client"
	evs = a.Add(conflicting2)
	if len(evs) != 1 {
		t.Fatalf("post-publish conflict returned %d events, want 1", len(evs))
	}
	if evs[0].Kind != EventRevision || len(evs[0].Conflicts) != 1 || len(evs[0].Spans) != 0 {
		t.Fatalf("unexpected conflict revision: %+v", evs[0])
	}
}

func TestLateOrphanAfterPublishIsFlaggedInRevision(t *testing.T) {
	a, clock := newTestAssembler(10 * time.Second)
	tid := traceID(5)
	a.Add(makeSpan(tid, spanID(1), SpanID{}, "root"))
	if evs := a.FlushExpired(clock.Advance(11 * time.Second)); len(evs) != 1 {
		t.Fatalf("expected snapshot, got %d events", len(evs))
	}

	// A brand-new orphan arrives after publication: the revision must carry
	// the root cause immediately.
	lateOrphan := makeSpan(tid, spanID(2), spanID(77), "late-orphan")
	evs := a.Add(lateOrphan)
	if len(evs) != 1 {
		t.Fatalf("Add(late orphan) returned %d events, want 1", len(evs))
	}
	ev := evs[0]
	if len(ev.Orphans) != 1 || ev.Orphans[0].MissingParent != spanID(77) {
		t.Fatalf("revision orphans = %+v, want missing parent %v", ev.Orphans, spanID(77))
	}
}

func TestForgetResetsTrace(t *testing.T) {
	a, clock := newTestAssembler(10 * time.Second)
	tid := traceID(6)
	a.Add(makeSpan(tid, spanID(1), SpanID{}, "root"))
	a.FlushExpired(clock.Advance(11 * time.Second))

	a.Forget(tid)
	if got := a.Pending(); got != 0 {
		t.Fatalf("Pending = %d, want 0 after Forget", got)
	}
	a.Add(makeSpan(tid, spanID(1), SpanID{}, "root"))
	if got := a.Pending(); got != 1 {
		t.Fatalf("Pending = %d, want 1 after re-adding", got)
	}
}

func TestConcurrentAddAndFlush(t *testing.T) {
	a, clock := newTestAssembler(time.Millisecond)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			tid := traceID(byte(i + 1))
			for j := 0; j < 50; j++ {
				a.Add(makeSpan(tid, spanID(byte(j+1)), spanID(byte(j)), "s"))
			}
		}(i)
	}
	wg.Wait()
	clock.Advance(2 * time.Millisecond)
	if evs := a.FlushExpired(clock.Now()); len(evs) != 8 {
		t.Fatalf("FlushExpired returned %d events, want 8", len(evs))
	}
}
