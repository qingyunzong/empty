package dataeng

import "sort"

// ChangeEvent is an alias for Event.
type ChangeEvent = Event

// Options is an alias for MergerOptions.
type Options = MergerOptions

// MergeOptions is an alias for MergerOptions.
type MergeOptions = MergerOptions

// New returns a merger for the supplied active shards.
func New(shards ...string) *Merger {
	return NewMerger(shards...)
}

// NewWithOptions returns a configured merger.
func NewWithOptions(opts Options) *Merger {
	return NewMergerWithOptions(opts)
}

// Resume restores a merger from a checkpoint.
func Resume(checkpoint Checkpoint, opts MergerOptions) *Merger {
	return ResumeMerger(checkpoint, opts)
}

// Merge accepts one event and returns the events that became safe to emit.
func (m *Merger) Merge(event Event) ([]Event, error) {
	return m.Push(event)
}

// MergeBatch accepts a group of events before draining.
func (m *Merger) MergeBatch(events []Event) (MergeResult, error) {
	return m.PushBatch(events)
}

// CompareEvents compares two events by the merger's global ordering. It does
// not account for a Merger-assigned Sequence; use Position for emitted events.
func CompareEvents(a, b Event) int {
	switch {
	case eventLess(a, b, 0, 0):
		return -1
	case eventLess(b, a, 0, 0):
		return 1
	default:
		return 0
	}
}

// SortEvents returns a stable copy of events in the merger's global order.
func SortEvents(events []Event) []Event {
	type indexed struct {
		event Event
		index int
	}
	indexedEvents := make([]indexed, len(events))
	for i, event := range events {
		indexedEvents[i] = indexed{event: event, index: i}
	}
	sort.SliceStable(indexedEvents, func(i, j int) bool {
		return eventLess(indexedEvents[i].event, indexedEvents[j].event, uint64(indexedEvents[i].index), uint64(indexedEvents[j].index))
	})
	out := make([]Event, len(events))
	for i, event := range indexedEvents {
		out[i] = event.event
	}
	return out
}
