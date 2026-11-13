package dataeng

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

// Options configures an Assembler.
type Options struct {
	// PublishTimeout is how long a trace may accumulate spans before its
	// first snapshot is published by FlushExpired. Missing parents do not
	// extend the deadline; they are reported as OrphanCause instead.
	PublishTimeout time.Duration
	// Now supplies the current time. Defaults to time.Now. Tests inject a
	// fake clock here and drive publication via FlushExpired.
	Now func() time.Time
}

func (o Options) withDefaults() Options {
	if o.PublishTimeout <= 0 {
		o.PublishTimeout = 30 * time.Second
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return o
}

// orphanWait tracks the spans blocked on one missing parent span ID.
type orphanWait struct {
	firstSeen time.Time
	spanIDs   []SpanID
}

// traceState is the mutable per-track assembly state.
type traceState struct {
	id        TraceID
	firstSeen time.Time
	spans     map[SpanID]Span
	hashes    map[SpanID][32]byte
	order     []SpanID // insertion order, for deterministic snapshots
	orphans   map[SpanID]*orphanWait
	conflicts []Conflict
	version   uint64
	published bool
}

func newTraceState(id TraceID, now time.Time) *traceState {
	return &traceState{
		id:        id,
		firstSeen: now,
		spans:     make(map[SpanID]Span),
		hashes:    make(map[SpanID][32]byte),
		orphans:   make(map[SpanID]*orphanWait),
	}
}

// Assembler merges out-of-order spans, links, resources and scopes into
// versioned traces. It is safe for concurrent use.
//
// Usage: feed spans with Add, call FlushExpired periodically (e.g. from a
// ticker), and forward the returned events downstream. Add returns revision
// events synchronously for traces that were already published.
type Assembler struct {
	opts   Options
	mu     sync.Mutex
	traces map[TraceID]*traceState
}

// New creates an Assembler.
func New(opts Options) *Assembler {
	return &Assembler{
		opts:   opts.withDefaults(),
		traces: make(map[TraceID]*traceState),
	}
}

// Add ingests one span. It returns the events emitted synchronously as a
// result: at most one revision event, and only when the trace was already
// published. Duplicate deliveries (identical content) are dropped silently;
// conflicting redeliveries are isolated and reported as Conflicts.
func (a *Assembler) Add(s Span) []Event {
	if s.TraceID.IsZero() || s.SpanID.IsZero() {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()

	now := a.opts.Now()
	tr, ok := a.traces[s.TraceID]
	if !ok {
		tr = newTraceState(s.TraceID, now)
		a.traces[s.TraceID] = tr
	}

	sum := contentHash(s)
	if existing, ok := tr.spans[s.SpanID]; ok {
		if tr.hashes[s.SpanID] == sum {
			return nil // exact duplicate
		}
		c := Conflict{
			SpanID:   s.SpanID,
			Kept:     existing,
			Rejected: s,
			Reason: fmt.Sprintf("span %s redelivered with different content (kept hash %s)",
				s.SpanID, hashString(tr.hashes[s.SpanID])),
		}
		tr.conflicts = append(tr.conflicts, c)
		if tr.published {
			return []Event{a.newRevisionLocked(tr, Event{Conflicts: []Conflict{c}})}
		}
		return nil
	}

	tr.spans[s.SpanID] = s
	tr.hashes[s.SpanID] = sum
	tr.order = append(tr.order, s.SpanID)

	// Resolve orphans that were waiting for this span as their parent.
	var resolved []SpanID
	if w, ok := tr.orphans[s.SpanID]; ok {
		resolved = append(resolved, w.spanIDs...)
		delete(tr.orphans, s.SpanID)
	}

	// Register this span as an orphan if its parent is not here yet.
	var newOrphan *OrphanCause
	if !s.ParentSpanID.IsZero() {
		if _, ok := tr.spans[s.ParentSpanID]; !ok {
			w, ok := tr.orphans[s.ParentSpanID]
			if !ok {
				w = &orphanWait{firstSeen: now}
				tr.orphans[s.ParentSpanID] = w
			}
			w.spanIDs = append(w.spanIDs, s.SpanID)
			newOrphan = &OrphanCause{
				MissingParent: s.ParentSpanID,
				OrphanSpans:   append([]SpanID(nil), w.spanIDs...),
			}
		}
	}

	if !tr.published {
		return nil
	}

	// Late arrival after publication: emit an incremental revision instead
	// of republishing the whole trace.
	ev := Event{
		Spans:           []Span{s},
		ResolvedOrphans: resolved,
	}
	if newOrphan != nil {
		ev.Orphans = []OrphanCause{*newOrphan}
	}
	return []Event{a.newRevisionLocked(tr, ev)}
}

// newRevisionLocked bumps the trace version and stamps the event.
func (a *Assembler) newRevisionLocked(tr *traceState, ev Event) Event {
	tr.version++
	ev.TraceID = tr.id
	ev.Version = tr.version
	ev.Kind = EventRevision
	return ev
}

// FlushExpired publishes a snapshot for every trace whose publish deadline
// (first span seen + PublishTimeout) has passed. Traces with missing parents
// are published anyway, with OrphanCause root-cause markers attached.
// Events are returned in TraceID order for determinism.
func (a *Assembler) FlushExpired(now time.Time) []Event {
	a.mu.Lock()
	defer a.mu.Unlock()

	ids := make([]TraceID, 0, len(a.traces))
	for id, tr := range a.traces {
		if !tr.published && !now.Before(tr.firstSeen.Add(a.opts.PublishTimeout)) {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool {
		return string(ids[i][:]) < string(ids[j][:])
	})

	events := make([]Event, 0, len(ids))
	for _, id := range ids {
		tr := a.traces[id]
		tr.published = true
		tr.version = 1
		ev := Event{
			TraceID:   tr.id,
			Version:   tr.version,
			Kind:      EventSnapshot,
			Spans:     make([]Span, 0, len(tr.order)),
			Conflicts: append([]Conflict(nil), tr.conflicts...),
		}
		for _, sid := range tr.order {
			ev.Spans = append(ev.Spans, tr.spans[sid])
		}
		ev.Orphans = orphanCauses(tr, now)
		events = append(events, ev)
	}
	return events
}

// orphanCauses snapshots the currently unresolved orphans.
func orphanCauses(tr *traceState, now time.Time) []OrphanCause {
	if len(tr.orphans) == 0 {
		return nil
	}
	parents := make([]SpanID, 0, len(tr.orphans))
	for pid := range tr.orphans {
		parents = append(parents, pid)
	}
	sort.Slice(parents, func(i, j int) bool {
		return string(parents[i][:]) < string(parents[j][:])
	})
	causes := make([]OrphanCause, 0, len(parents))
	for _, pid := range parents {
		w := tr.orphans[pid]
		causes = append(causes, OrphanCause{
			MissingParent: pid,
			OrphanSpans:   append([]SpanID(nil), w.spanIDs...),
			Waited:        now.Sub(w.firstSeen),
		})
	}
	return causes
}

// Forget drops all state for a trace, e.g. after the pipeline has fully
// drained it. Late spans for a forgotten trace start a fresh trace.
func (a *Assembler) Forget(id TraceID) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.traces, id)
}

// Pending reports how many traces are still waiting for their first
// publication.
func (a *Assembler) Pending() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := 0
	for _, tr := range a.traces {
		if !tr.published {
			n++
		}
	}
	return n
}
