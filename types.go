package dataeng

import (
	"encoding/hex"
	"fmt"
	"time"
)

// TraceID identifies a trace. The zero value is invalid.
type TraceID [16]byte

// SpanID identifies a span within a trace. The zero value means "no span"
// and is used as the ParentSpanID of root spans.
type SpanID [8]byte

// IsZero reports whether the ID is unset.
func (t TraceID) IsZero() bool { return t == TraceID{} }

// IsZero reports whether the ID is unset.
func (s SpanID) IsZero() bool { return s == SpanID{} }

// String returns the lowercase hex encoding of the ID.
func (t TraceID) String() string { return hex.EncodeToString(t[:]) }

// String returns the lowercase hex encoding of the ID.
func (s SpanID) String() string { return hex.EncodeToString(s[:]) }

// Resource describes the entity that produced a span, e.g. a service
// instance. Spans of one trace may carry distinct resources.
type Resource struct {
	Attributes map[string]string
}

// Scope identifies the instrumentation library that produced a span.
type Scope struct {
	Name       string
	Version    string
	Attributes map[string]string
}

// Link is a span-to-span reference, possibly across traces.
type Link struct {
	TraceID    TraceID
	SpanID     SpanID
	Attributes map[string]string
}

// Span is a single unit of work. Resource and Scope travel with the span so
// that out-of-order fragments can be merged without a separate control
// channel.
type Span struct {
	TraceID      TraceID
	SpanID       SpanID
	ParentSpanID SpanID
	Name         string
	Kind         string
	Start        time.Time
	End          time.Time
	Attributes   map[string]string
	Links        []Link
	Resource     Resource
	Scope        Scope
}

// EventKind distinguishes a full snapshot from an incremental revision.
type EventKind int

const (
	// EventSnapshot carries every accepted span of the trace. It is the
	// first event emitted for a trace and is triggered by the publish
	// timeout, even when parents are still missing.
	EventSnapshot EventKind = iota
	// EventRevision carries only the spans that changed after the last
	// published event, never the whole trace again.
	EventRevision
)

func (k EventKind) String() string {
	switch k {
	case EventSnapshot:
		return "snapshot"
	case EventRevision:
		return "revision"
	default:
		return fmt.Sprintf("EventKind(%d)", int(k))
	}
}

// OrphanCause explains why a span was published without its parent. It is
// the root-cause marker attached to events that contain unresolved orphans.
type OrphanCause struct {
	// MissingParent is the parent span ID that never arrived in time.
	MissingParent SpanID
	// OrphanSpans are the accepted spans waiting on MissingParent.
	OrphanSpans []SpanID
	// Waited is how long the orphans had been waiting when the event was
	// emitted.
	Waited time.Duration
}

// Conflict records a span whose SpanID was already accepted with different
// content. The conflicting copy is isolated here and never merged into the
// trace body.
type Conflict struct {
	SpanID   SpanID
	Kept     Span
	Rejected Span
	Reason   string
}

// Event is a versioned publication unit for one trace. Consumers apply
// events in Version order per TraceID.
type Event struct {
	TraceID TraceID
	// Version starts at 1 for the snapshot and increments per revision.
	Version uint64
	Kind    EventKind
	// Spans holds every accepted span for a snapshot, or only the changed
	// spans for a revision.
	Spans []Span
	// Orphans lists unresolved missing parents at emission time.
	Orphans []OrphanCause
	// Conflicts lists isolated span conflicts known at emission time.
	Conflicts []Conflict
	// ResolvedOrphans lists span IDs whose missing parent was resolved by
	// this revision (late parent arrival).
	ResolvedOrphans []SpanID
}
