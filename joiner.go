// Package dataeng joins two telemetry event streams (left and right) by key
// over a closed int64 time interval.
//
// A right event matches a left event when their keys are equal and the right
// time lies within [leftTime-A, leftTime+B]. A and B are non-negative int64
// values and every comparison is performed without int64 overflow.
//
// Each stream has a monotonically non-decreasing watermark and may be ended
// once. Ending a stream installs a positive-infinity watermark and forbids
// further input on that stream. A left event is delivered as one result group
// only once it is sealed: the left watermark is strictly greater than the left
// time and the right watermark is strictly greater than the mathematical
// (possibly out-of-int64-range) value leftTime+B, with all earlier left events
// already sealed.
//
// A Joiner is single-goroutine; it is not safe for concurrent use. Delivery is
// at-least-once: when the callback fails (or the outcome is unknown) the whole
// group is retained and retried, so the callback must be idempotent by left ID.
package dataeng

import (
	"container/heap"
	"errors"
	"math"
	"sort"
)

// Side selects one of the two joined streams.
type Side int

const (
	// Left is the stream whose events produce result groups.
	Left Side = iota + 1
	// Right is the stream whose events produce matches inside left groups.
	Right
)

// Event is a uniquely identified keyed event with an int64 timestamp.
type Event struct {
	ID   string
	Key  string
	Time int64
}

// Group is the complete result set for one left event. Matches is non-nil and
// empty for an unmatched left event.
type Group struct {
	Left    Event
	Matches []Event
}

// Input errors. Every rejected input leaves the joiner state unchanged.
var (
	// ErrStreamEnded is returned when an event or watermark is sent to an
	// already ended stream.
	ErrStreamEnded = errors.New("dataeng: stream already ended")
	// ErrWatermarkViolation is returned when an event time is below the
	// current watermark of its stream.
	ErrWatermarkViolation = errors.New("dataeng: event time below watermark")
	// ErrWatermarkRegression is returned when a watermark moves backwards.
	ErrWatermarkRegression = errors.New("dataeng: watermark cannot regress")
	// ErrInconsistentEvent is returned when an event reuses an existing ID
	// with a different key or timestamp.
	ErrInconsistentEvent = errors.New("dataeng: same event ID with different content")
	// ErrInvalidSide is returned for a Side value that is neither Left nor Right.
	ErrInvalidSide = errors.New("dataeng: invalid stream side")
	// ErrInvalidConfig is returned for negative A or B, or a nil callback.
	ErrInvalidConfig = errors.New("dataeng: A and B must be non-negative and callback must be non-nil")
)

// Joiner performs the interval join. Create one with New.
type Joiner struct {
	a       int64
	b       int64
	deliver func(Group) error

	left    stream
	right   stream
	pending leftHeap
}

type stream struct {
	ended bool
	// wmSet reports whether wm has been set explicitly. Before the first
	// watermark the stream behaves as if its watermark were negative infinity.
	wmSet bool
	wm    int64
	// events stores every accepted event by ID for duplicate and consistency
	// checks. IDs are independent between the two streams.
	events map[string]Event
}

type leftEntry struct {
	Event
	index int
}

// leftHeap orders undelivered left events by (time, ID) where IDs are compared
// as UTF-8 bytes. Go string comparison is lexicographic over raw bytes, which
// is exactly the required ordering.
type leftHeap []*leftEntry

func (h leftHeap) Len() int { return len(h) }

func (h leftHeap) Less(i, j int) bool {
	if h[i].Time != h[j].Time {
		return h[i].Time < h[j].Time
	}
	return h[i].ID < h[j].ID
}

func (h leftHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].index = i
	h[j].index = j
}

func (h *leftHeap) Push(x any) {
	entry := x.(*leftEntry)
	entry.index = len(*h)
	*h = append(*h, entry)
}

func (h *leftHeap) Pop() any {
	old := *h
	n := len(old)
	entry := old[n-1]
	old[n-1] = nil
	entry.index = -1
	*h = old[:n-1]
	return entry
}

// New creates a Joiner with look-back A and look-ahead B. The closed match
// window is [leftTime-A, leftTime+B]. The callback receives each sealed group
// in (left time, left ID) order.
func New(a, b int64, deliver func(Group) error) (*Joiner, error) {
	if a < 0 || b < 0 || deliver == nil {
		return nil, ErrInvalidConfig
	}
	return &Joiner{
		a:       a,
		b:       b,
		deliver: deliver,
		left:    stream{events: make(map[string]Event)},
		right:   stream{events: make(map[string]Event)},
	}, nil
}

// Push accepts an event on the given stream. Re-delivering an identical event
// (same ID, key and time) is ignored; reusing the ID with different content is
// rejected. Events earlier than the stream watermark and all input after End
// are rejected without changing any state.
func (j *Joiner) Push(side Side, event Event) error {
	s, err := j.streamOf(side)
	if err != nil {
		return err
	}
	if s.ended {
		return ErrStreamEnded
	}
	if previous, ok := s.events[event.ID]; ok {
		if previous.Key != event.Key || previous.Time != event.Time {
			return ErrInconsistentEvent
		}
		return nil
	}
	if s.wmSet && event.Time < s.wm {
		return ErrWatermarkViolation
	}
	s.events[event.ID] = event
	if side == Left {
		heap.Push(&j.pending, &leftEntry{Event: event})
	}
	return j.pump()
}

// Watermark advances the watermark of a stream monotonically. It is rejected
// on an ended stream or when w is below the current watermark.
func (j *Joiner) Watermark(side Side, w int64) error {
	s, err := j.streamOf(side)
	if err != nil {
		return err
	}
	if s.ended {
		return ErrStreamEnded
	}
	if s.wmSet && w < s.wm {
		return ErrWatermarkRegression
	}
	s.wmSet = true
	s.wm = w
	return j.pump()
}

// End marks a stream as finished, which is equivalent to a positive-infinity
// watermark. Calling it again on an ended stream does not change the stream
// state but still retries any groups whose callbacks previously failed.
func (j *Joiner) End(side Side) error {
	s, err := j.streamOf(side)
	if err != nil {
		return err
	}
	s.ended = true
	return j.pump()
}

func (j *Joiner) streamOf(side Side) (*stream, error) {
	switch side {
	case Left:
		return &j.left, nil
	case Right:
		return &j.right, nil
	default:
		return nil, ErrInvalidSide
	}
}

// inWindow reports whether rightTime lies in the closed window
// [leftTime-a, leftTime+b] using only overflow-free comparisons.
func inWindow(rightTime, leftTime, a, b int64) bool {
	return aboveOrEqualLower(rightTime, leftTime, a) &&
		!greaterThanSum(rightTime, leftTime, b)
}

// aboveOrEqualLower reports rightTime >= leftTime-a without overflow.
func aboveOrEqualLower(rightTime, leftTime, a int64) bool {
	if leftTime >= 0 {
		// leftTime-a cannot underflow when leftTime >= 0 and a >= 0.
		return rightTime >= leftTime-a
	}
	// leftTime < 0: subtraction underflows when a exceeds
	// leftTime-MinInt64 (a positive quantity since leftTime < 0).
	if a > leftTime-math.MinInt64 {
		// leftTime-a is mathematically below MinInt64, so every int64
		// rightTime is above or equal to it.
		return true
	}
	return rightTime >= leftTime-a
}

// greaterThanSum reports rightTime > leftTime+b without overflow, where b >= 0.
func greaterThanSum(rightTime, leftTime, b int64) bool {
	if leftTime < 0 {
		// leftTime+b cannot overflow when leftTime < 0 and b <= MaxInt64.
		return rightTime > leftTime+b
	}
	// leftTime >= 0: addition overflows when b > MaxInt64-leftTime.
	if b > math.MaxInt64-leftTime {
		// leftTime+b is mathematically above MaxInt64, so no int64
		// rightTime can be strictly greater.
		return false
	}
	return rightTime > leftTime+b
}

// sealed reports whether no future right event can ever match the left event
// and whether the left event itself is past its left watermark.
func (j *Joiner) sealed(event Event) bool {
	leftOK := j.left.ended || (j.left.wmSet && j.left.wm > event.Time)
	rightOK := j.right.ended ||
		(j.right.wmSet && greaterThanSum(j.right.wm, event.Time, j.b))
	return leftOK && rightOK
}

// buildGroup collects every accepted right event matching the left event and
// orders the matches by (time, ID).
func (j *Joiner) buildGroup(left Event) Group {
	matches := make([]Event, 0)
	for _, right := range j.right.events {
		if right.Key == left.Key && inWindow(right.Time, left.Time, j.a, j.b) {
			matches = append(matches, right)
		}
	}
	sort.Slice(matches, func(i, k int) bool {
		if matches[i].Time != matches[k].Time {
			return matches[i].Time < matches[k].Time
		}
		return matches[i].ID < matches[k].ID
	})
	return Group{Left: left, Matches: matches}
}

// pump delivers every sealed group in delivery order. The head group is
// retained when the callback fails and delivery stops so the same group is
// retried on the next mutating call.
func (j *Joiner) pump() error {
	for j.pending.Len() > 0 {
		head := j.pending[0]
		if !j.sealed(head.Event) {
			return nil
		}
		group := j.buildGroup(head.Event)
		if err := j.deliver(group); err != nil {
			return err
		}
		heap.Pop(&j.pending)
	}
	return nil
}
