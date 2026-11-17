package formal

import (
	"errors"
	"fmt"
	"time"
)

// TraceID identifies a distributed trace.
type TraceID string

// Fragment is one span fragment produced by a distributed tracer.
//
// Start is the span's event-time start. End may be left zero when Duration is
// supplied. A fragment with neither End nor Duration is treated as an instant
// at Start. Fragments may arrive in any order.
type Fragment struct {
	TraceID TraceID

	// ID is an optional fragment identity. When it is empty, SpanID is used.
	// IDs must be unique within a trace; duplicates are merged idempotently.
	ID     string
	SpanID string

	ParentSpanID string
	Service      string

	Start    time.Time
	End      time.Time
	Duration time.Duration

	Error bool

	// Attributes are business attributes such as tenant, route, or region.
	Attributes map[string]string
}

// ErrInvalidFragment is returned when a fragment cannot identify or describe a
// span.
var ErrInvalidFragment = errors.New("formal: invalid fragment")

func (f Fragment) key() string {
	if f.ID != "" {
		return f.ID
	}
	return f.SpanID
}

func normalizeFragment(f Fragment, now time.Time) (Fragment, error) {
	if f.TraceID == "" {
		return Fragment{}, fmt.Errorf("%w: missing trace id", ErrInvalidFragment)
	}
	if f.key() == "" {
		return Fragment{}, fmt.Errorf("%w: missing fragment id and span id", ErrInvalidFragment)
	}
	if f.Duration < 0 {
		return Fragment{}, fmt.Errorf("%w: negative duration", ErrInvalidFragment)
	}

	if f.Start.IsZero() {
		if !f.End.IsZero() {
			f.Start = f.End.Add(-f.Duration)
		} else {
			f.Start = now.Add(-f.Duration)
		}
	}
	if f.End.IsZero() {
		f.End = f.Start.Add(f.Duration)
	}
	if f.End.Before(f.Start) {
		return Fragment{}, fmt.Errorf("%w: end precedes start", ErrInvalidFragment)
	}
	f.Duration = f.End.Sub(f.Start)

	if len(f.Attributes) != 0 {
		attrs := make(map[string]string, len(f.Attributes))
		for k, v := range f.Attributes {
			attrs[k] = v
		}
		f.Attributes = attrs
	}
	return f, nil
}
