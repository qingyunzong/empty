package dataeng

import (
	"fmt"
	"sync"
	"time"
	"unicode/utf8"
)

// Option configures an Aggregator.
type Option func(*Aggregator)

// WithClock replaces the clock used by Push, Flush, and Terminate. It is mainly
// useful for deterministic tests.
func WithClock(clock func() time.Time) Option {
	return func(a *Aggregator) {
		if clock != nil {
			a.clock = clock
		}
	}
}

// WithMaxEventBytes limits the size of one event, measured like Event.Bytes:
// line bytes plus one byte between adjacent lines. A value less than or equal
// to zero means unlimited.
func WithMaxEventBytes(limit int) Option {
	return func(a *Aggregator) {
		a.maxBytes = limit
	}
}

// Aggregator is a concurrency-safe multiline event state machine. It holds at
// most one unfinished event. All input, timeout, and flush operations share
// one mutex, which guarantees that a completed event is emitted exactly once
// even when a scheduled flush races with a new start line.
type Aggregator struct {
	mu       sync.Mutex
	rule     Rule
	maxBytes int
	clock    func() time.Time
	nextSeq  uint64
	current  *PendingEvent
}

// NewAggregator creates a multiline state machine. The rule is copied and may
// be reused by callers.
func NewAggregator(rule Rule, opts ...Option) *Aggregator {
	a := &Aggregator{
		rule:    rule,
		clock:   time.Now,
		nextSeq: 1,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(a)
		}
	}
	if a.clock == nil {
		a.clock = time.Now
	}
	return a
}

// Push feeds one line using the current clock.
func (a *Aggregator) Push(line Line) []Event {
	return a.PushAt(line, a.now())
}

// PushAt feeds one line at a specific time. now is used for timeout checks and
// event timestamps. It lets callers drive the state machine deterministically.
func (a *Aggregator) PushAt(line Line, now time.Time) []Event {
	a.mu.Lock()
	defer a.mu.Unlock()

	if now.IsZero() {
		now = a.clock()
	}
	var events []Event

	if a.current != nil && a.timedOutLocked(now) {
		events = append(events, a.emitLocked(ReasonTimeout, nil, now))
	}

	text := line.Text
	if !utf8.Valid(text) {
		if a.current != nil {
			err := fmt.Errorf("%w at byte offset %d", ErrEncoding, line.StartOffset)
			events = append(events, a.emitLocked(ReasonEncoding, err, now))
		}
		// Undecodable input cannot be represented as an event line.
		return events
	}

	value := string(text)
	start := line.StartOffset
	end := line.EndOffset
	if end < start {
		end = start
	}

	switch {
	case a.rule.Start != nil && a.rule.Start(value):
		if a.current != nil {
			events = append(events, a.emitLocked(ReasonNewStart, nil, now))
		}
		events = append(events, a.startLocked(value, start, end, now)...)
	case a.current != nil && a.rule.Continue != nil && a.rule.Continue(value):
		events = append(events, a.appendLocked(value, start, end, now)...)
	case a.current != nil:
		events = append(events, a.emitLocked(ReasonNewStart, nil, now))
		events = append(events, a.startLocked(value, start, end, now)...)
	default:
		events = append(events, a.startLocked(value, start, end, now)...)
	}
	return events
}

// Flush completes the open event, if any, with the supplied reason. An empty
// reason is treated as ReasonFlush.
func (a *Aggregator) Flush(reason TermReason) []Event {
	return a.Terminate(reason, nil)
}

// Terminate completes the open event, if any, with the supplied reason and
// cause. The cause is stored on Event.Err; callers commonly pass a value that
// wraps ErrRotation, ErrTruncation, ErrEncoding, or ErrMaxBytes.
func (a *Aggregator) Terminate(reason TermReason, cause error) []Event {
	a.mu.Lock()
	defer a.mu.Unlock()

	if reason == "" {
		reason = ReasonFlush
	}
	if a.current == nil {
		return nil
	}
	return []Event{a.emitLocked(reason, cause, a.clock())}
}

// FlushDue evaluates the timeout predicate and completes the open event if it
// is due. It is safe to call from a timer goroutine while Push runs elsewhere.
func (a *Aggregator) FlushDue(now time.Time) []Event {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.current == nil || !a.timedOutLocked(now) {
		return nil
	}
	return []Event{a.emitLocked(ReasonTimeout, nil, now)}
}

// Tick is FlushDue using the aggregator's clock.
func (a *Aggregator) Tick() []Event {
	return a.FlushDue(a.now())
}

// Current returns a copy of the unfinished event.
func (a *Aggregator) Current() (PendingEvent, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.current == nil {
		return PendingEvent{}, false
	}
	pending := *a.current
	pending.Lines = append([]string(nil), a.current.Lines...)
	return pending, true
}

func (a *Aggregator) timedOutLocked(now time.Time) bool {
	if a.current == nil || a.rule.Timeout == nil {
		return false
	}
	return a.rule.Timeout(now.Sub(a.current.Updated))
}

func (a *Aggregator) appendLocked(text string, start, end int64, now time.Time) []Event {
	pending := a.current
	if a.maxBytes > 0 && pending.Size+1+len(text) > a.maxBytes {
		events := []Event{a.emitLocked(ReasonMaxBytes, fmt.Errorf("%w: limit %d", ErrMaxBytes, a.maxBytes), now)}
		return append(events, a.startLocked(text, start, end, now)...)
	}
	pending.Lines = append(pending.Lines, text)
	pending.Size += 1 + len(text)
	pending.EndOffset = end
	pending.Updated = now
	return nil
}

func (a *Aggregator) startLocked(text string, start, end int64, now time.Time) []Event {
	pending := &PendingEvent{
		Seq:         a.nextSeq,
		Lines:       []string{text},
		StartOffset: start,
		EndOffset:   end,
		Started:     now,
		Updated:     now,
		Size:        len(text),
	}
	a.nextSeq++
	a.current = pending

	if a.maxBytes > 0 && pending.Size > a.maxBytes {
		pending.Lines[0] = truncateUTF8(text, a.maxBytes)
		pending.Size = len(pending.Lines[0])
		pending.Truncated = true
		err := fmt.Errorf("%w: line truncated at %d bytes", ErrMaxBytes, a.maxBytes)
		return []Event{a.emitLocked(ReasonMaxBytes, err, now)}
	}
	return nil
}

func (a *Aggregator) emitLocked(reason TermReason, cause error, now time.Time) Event {
	pending := a.current
	event := Event{
		Seq:         pending.Seq,
		Lines:       append([]string(nil), pending.Lines...),
		StartOffset: pending.StartOffset,
		EndOffset:   pending.EndOffset,
		Started:     pending.Started,
		Ended:       now,
		Reason:      reason,
		Truncated:   pending.Truncated,
		Err:         cause,
	}
	a.current = nil
	return event
}

func (a *Aggregator) now() time.Time {
	if a.clock == nil {
		return time.Now()
	}
	return a.clock()
}

func truncateUTF8(s string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(s) <= limit {
		return s
	}
	buf := []byte(s[:limit])
	for len(buf) > 0 && !utf8.Valid(buf) {
		buf = buf[:len(buf)-1]
	}
	return string(buf)
}
