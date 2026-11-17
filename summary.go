package formal

import "time"

// TraceSummary is the order-independent aggregate of all fragments observed
// for a trace.
type TraceSummary struct {
	TraceID TraceID

	Start    time.Time
	End      time.Time
	Duration time.Duration

	SpanCount  int
	ErrorCount int
	HasError   bool

	// Services contains the distinct services touched by the trace, sorted.
	Services []string

	// Attributes contains business attributes. When several spans define the
	// same attribute, the value from the span with the earliest Start wins;
	// ties are broken by fragment ID. This makes the aggregate independent of
	// fragment arrival order.
	Attributes map[string]string
}

// Attribute returns the merged business attribute named key.
func (s TraceSummary) Attribute(key string) (string, bool) {
	v, ok := s.Attributes[key]
	return v, ok
}

// HasService reports whether any observed span belongs to service.
func (s TraceSummary) HasService(service string) bool {
	for _, got := range s.Services {
		if got == service {
			return true
		}
	}
	return false
}

func (s TraceSummary) clone() TraceSummary {
	if s.Services != nil {
		s.Services = append([]string(nil), s.Services...)
	}
	if s.Attributes != nil {
		attrs := make(map[string]string, len(s.Attributes))
		for k, v := range s.Attributes {
			attrs[k] = v
		}
		s.Attributes = attrs
	}
	return s
}
