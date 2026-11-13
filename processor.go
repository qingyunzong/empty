package dataeng

import (
	"sort"
	"sync"
	"time"
)

// Processor assigns events to keyed tumbling windows and applies the
// external watermark, allowed lateness and side-output rules described in
// the package documentation.
//
// Processor methods are safe for concurrent use. Outputs are returned in a
// deterministic order for a single call: windows are ordered by start time
// and then by key.
type Processor struct {
	mu   sync.Mutex
	opts Options

	watermark    time.Time
	hasWatermark bool
	windows      map[windowKey]*windowState
}

type windowKey struct {
	key   string
	start time.Time
}

type windowState struct {
	key    string
	window Window

	sum   int64
	count int64

	closed  bool
	emitted bool
	version int
	lastSum int64
	lastN   int64
}

// NewProcessor validates opts and constructs a Processor.
func NewProcessor(opts Options) (*Processor, error) {
	normalized, err := opts.normalized()
	if err != nil {
		return nil, err
	}
	return &Processor{
		opts:    normalized,
		windows: make(map[windowKey]*windowState),
	}, nil
}

// MustNewProcessor is like NewProcessor but panics on an invalid Options.
func MustNewProcessor(opts Options) *Processor {
	p, err := NewProcessor(opts)
	if err != nil {
		panic(err)
	}
	return p
}

// New constructs a Processor with the system clock.
func New(windowSize, allowedLateness time.Duration) (*Processor, error) {
	return NewProcessor(Options{
		WindowSize:      windowSize,
		AllowedLateness: allowedLateness,
	})
}

// NewWithClock constructs a Processor with an explicit clock.
func NewWithClock(windowSize, allowedLateness time.Duration, clock Clock) (*Processor, error) {
	return NewProcessor(Options{
		WindowSize:      windowSize,
		AllowedLateness: allowedLateness,
		Clock:           clock,
	})
}

// Process ingests one event and returns any records caused by it.
//
// Process never changes the watermark. An event for an open window updates
// that window silently. An event for a closed window that is still within
// its allowed lateness produces a retraction of the previous result and a
// corrected result. An event past the allowed lateness produces a side
// output.
func (p *Processor) Process(ev Event) []Output {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := p.lazyClock()
	window := p.windowFor(ev.Timestamp)
	key := windowKey{key: ev.Key, start: window.Start}

	if p.hasWatermark && !p.watermark.Before(window.End.Add(p.opts.AllowedLateness)) {
		return []Output{p.sideOutput(ev, window, now())}
	}

	state := p.windows[key]
	if state == nil {
		state = &windowState{
			key:    ev.Key,
			window: window,
			closed: p.hasWatermark && !p.watermark.Before(window.End),
		}
		p.windows[key] = state
		state.add(ev)
		if state.closed {
			return p.emitResult(state, now())
		}
		return nil
	}

	if state.closed {
		var out []Output
		if state.emitted {
			out = append(out, p.retractionOutput(state, now()))
		}
		state.add(ev)
		out = append(out, p.emitResult(state, now())...)
		return out
	}

	state.add(ev)
	return nil
}

// AdvanceWatermark supplies a new external watermark. Values that do not
// move the watermark forward are ignored. Passing exactly End closes a
// window; passing End+AllowedLateness expires it.
//
// AdvanceWatermark never advances beyond the value supplied by the caller.
func (p *Processor) AdvanceWatermark(watermark time.Time) []Output {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.hasWatermark && !watermark.After(p.watermark) {
		return nil
	}
	p.watermark = watermark
	p.hasWatermark = true

	now := p.lazyClock()
	keys := make([]windowKey, 0, len(p.windows))
	for key := range p.windows {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if !keys[i].start.Equal(keys[j].start) {
			return keys[i].start.Before(keys[j].start)
		}
		return keys[i].key < keys[j].key
	})

	var out []Output
	for _, key := range keys {
		state := p.windows[key]
		if state == nil {
			continue
		}
		if !state.closed && !watermark.Before(state.window.End) {
			out = append(out, p.emitResult(state, now())...)
		}
		if !watermark.Before(state.window.End.Add(p.opts.AllowedLateness)) {
			delete(p.windows, key)
		}
	}
	return out
}

// Watermark returns the current external watermark. It returns the zero
// time if no watermark has been supplied.
func (p *Processor) Watermark() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.watermark
}

// HasWatermark reports whether an external watermark has been supplied.
func (p *Processor) HasWatermark() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.hasWatermark
}

// AllowedLateness returns the configured allowed lateness.
func (p *Processor) AllowedLateness() time.Duration {
	return p.opts.AllowedLateness
}

// WindowSize returns the configured window size.
func (p *Processor) WindowSize() time.Duration {
	return p.opts.WindowSize
}

func (p *Processor) windowFor(ts time.Time) Window {
	size := p.opts.WindowSize
	delta := ts.Sub(p.opts.Origin)
	index := delta / size
	if delta < 0 && delta%size != 0 {
		index--
	}
	start := p.opts.Origin.Add(index * size)
	return Window{Start: start, End: start.Add(size)}
}

func (s *windowState) add(ev Event) {
	s.sum += ev.Value
	s.count++
}

func (p *Processor) lazyClock() func() time.Time {
	var (
		now     time.Time
		hasRead bool
	)
	return func() time.Time {
		if !hasRead {
			now = p.opts.Clock.Now()
			hasRead = true
		}
		return now
	}
}

func (p *Processor) emitResult(state *windowState, at time.Time) []Output {
	state.closed = true
	state.version++
	state.lastSum = state.sum
	state.lastN = state.count
	state.emitted = true
	return []Output{{
		Kind:           KindResult,
		Key:            state.key,
		Window:         state.window,
		Value:          state.sum,
		Count:          state.count,
		Version:        state.version,
		Watermark:      p.watermark,
		ProcessingTime: at,
	}}
}

func (p *Processor) retractionOutput(state *windowState, at time.Time) Output {
	return Output{
		Kind:           KindRetraction,
		Key:            state.key,
		Window:         state.window,
		Value:          state.lastSum,
		Count:          state.lastN,
		Version:        state.version,
		Watermark:      p.watermark,
		ProcessingTime: at,
	}
}

func (p *Processor) sideOutput(ev Event, window Window, at time.Time) Output {
	return Output{
		Kind:           KindSideOutput,
		Key:            ev.Key,
		Window:         window,
		Event:          ev,
		Watermark:      p.watermark,
		Reason:         ReasonPastAllowedLateness,
		ProcessingTime: at,
	}
}
