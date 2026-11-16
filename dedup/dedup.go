// Package dedup provides a layered, event-time-driven deduplication
// component for event ingestion pipelines.
//
// Layers, from hottest to coldest:
//
//   - an exact set holding every key of the currently active event-time
//     window (no false positives, no false negatives);
//   - a bounded list of sealed Bloom layers, one per past event-time
//     window (no false negatives; hits are only suspicions that are
//     confirmed against the persistent Index);
//   - the persistent Index itself, the authoritative record consulted for
//     suspicions and for events older than every retained window.
//
// Rotation is driven exclusively by the event-time watermark
// (AdvanceWatermark). The component never reads the wall clock, so
// processing delay can never cause a window to be sealed or dropped early.
//
// Crash recovery: Snapshot encodes the watermark, the exact set and every
// Bloom layer deterministically, so a restored Deduper follows exactly the
// same false-positive path as before and never produces false negatives.
// If the Index implements CheckpointableIndex, Snapshot flushes it first so
// that index and snapshot form a consistent cut; on restart, both must be
// restored from the same checkpoint generation.
package dedup

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// ErrEventAheadOfWatermark is returned by CheckAndAdd when the event time
// falls beyond the active window. The caller should advance the watermark
// (i.e. let event time progress) and retry.
var ErrEventAheadOfWatermark = errors.New("dedup: event time ahead of active window, advance the watermark first")

// Config configures a Deduper.
type Config struct {
	// WindowSize is the event-time span covered by the exact set and by
	// each sealed Bloom layer.
	WindowSize time.Duration
	// WindowCount is the number of sealed Bloom layers retained in
	// addition to the active exact set. Together they bound how much
	// event-time lateness is served from memory.
	WindowCount int
	// ExpectedPerWindow estimates the number of distinct keys per window;
	// it sizes the Bloom layers.
	ExpectedPerWindow int
	// FalsePositiveRate is the target false-positive rate of each Bloom
	// layer. False positives only cost an extra Index lookup; they never
	// change a verdict.
	FalsePositiveRate float64
}

func (c Config) validate() error {
	if c.WindowSize <= 0 {
		return fmt.Errorf("dedup: WindowSize must be positive, got %v", c.WindowSize)
	}
	if c.WindowCount < 0 {
		return fmt.Errorf("dedup: WindowCount must be >= 0, got %d", c.WindowCount)
	}
	if c.ExpectedPerWindow <= 0 {
		return fmt.Errorf("dedup: ExpectedPerWindow must be positive, got %d", c.ExpectedPerWindow)
	}
	if c.FalsePositiveRate <= 0 || c.FalsePositiveRate >= 1 {
		return fmt.Errorf("dedup: FalsePositiveRate must be in (0,1), got %v", c.FalsePositiveRate)
	}
	return nil
}

// layer is a sealed event-time window backed by a Bloom filter.
type layer struct {
	windowStart time.Time
	filter      *bloomFilter
}

// Deduper is a layered deduplication component. It is safe for concurrent
// use. The zero value is not usable; construct with New or Restore.
type Deduper struct {
	mu    sync.Mutex
	cfg   Config
	index Index

	watermark   time.Time
	windowStart time.Time // start of the active window; zero until initialised
	exact       map[string]struct{}
	layers      []layer // sealed windows, oldest first, contiguous, ending at windowStart
}

// New creates a Deduper. The active window is aligned lazily from the first
// event or watermark observed.
func New(cfg Config, index Index) (*Deduper, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	if index == nil {
		return nil, errors.New("dedup: index must not be nil")
	}
	return &Deduper{
		cfg:   cfg,
		index: index,
		exact: make(map[string]struct{}),
	}, nil
}

// align rounds t down to the window grid. Truncate is absolute (relative to
// the zero time), so the grid is stable across restarts.
func (d *Deduper) align(t time.Time) time.Time {
	return t.Truncate(d.cfg.WindowSize)
}

// AdvanceWatermark moves the event-time watermark forward and seals every
// window whose end is at or before t. It is the only trigger for rotation;
// the wall clock is never consulted, so processing delay cannot cause early
// forgetting. Non-increasing values are ignored.
func (d *Deduper) AdvanceWatermark(t time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !t.After(d.watermark) {
		return
	}
	d.watermark = t
	if d.windowStart.IsZero() {
		d.windowStart = d.align(t)
	}
	for !d.windowStart.Add(d.cfg.WindowSize).After(t) {
		d.rotateLocked()
	}
}

// rotateLocked seals the active window into a Bloom layer, drops the oldest
// layer when retention is exceeded, and opens the next window.
func (d *Deduper) rotateLocked() {
	filter := newBloomFilter(d.cfg.ExpectedPerWindow, d.cfg.FalsePositiveRate)
	for key := range d.exact {
		filter.add(key)
	}
	d.layers = append(d.layers, layer{windowStart: d.windowStart, filter: filter})
	if len(d.layers) > d.cfg.WindowCount {
		d.layers = append([]layer(nil), d.layers[len(d.layers)-d.cfg.WindowCount:]...)
	}
	d.exact = make(map[string]struct{}, len(d.exact))
	d.windowStart = d.windowStart.Add(d.cfg.WindowSize)
}

// CheckAndAdd reports whether key was already accepted for a previous event,
// and records it if not. eventTime selects the window the key is written to;
// duplicate detection always spans the exact set, every retained Bloom layer
// and, when necessary, the persistent index.
//
// Duplicate verdicts are exact: Bloom hits only raise a suspicion that is
// confirmed against the index, so Bloom false positives never change a
// verdict, and every accepted key is written to the index before the call
// returns, so no false negatives are possible.
func (d *Deduper) CheckAndAdd(ctx context.Context, key string, eventTime time.Time) (bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.windowStart.IsZero() {
		d.windowStart = d.align(eventTime)
	}
	if !eventTime.Before(d.windowStart.Add(d.cfg.WindowSize)) {
		return false, ErrEventAheadOfWatermark
	}

	// 1. Active window: exact answer.
	if _, ok := d.exact[key]; ok {
		return true, nil
	}

	// 2. Sealed windows: Bloom hits are suspicions only.
	suspect := false
	for i := range d.layers {
		if d.layers[i].filter.mayContain(key) {
			suspect = true
			break
		}
	}

	// 3. Confirm suspicions against the persistent index. Events older
	// than every retained window have no Bloom coverage at all, so they
	// must consult the index unconditionally.
	if suspect || d.beyondRetentionLocked(eventTime) {
		has, err := d.index.Has(ctx, key)
		if err != nil {
			return false, fmt.Errorf("dedup: index lookup: %w", err)
		}
		if has {
			return true, nil
		}
	}

	// New key: persist first, then record in memory. If Put fails nothing
	// is recorded anywhere, keeping all layers consistent.
	if err := d.index.Put(ctx, key); err != nil {
		return false, fmt.Errorf("dedup: index write: %w", err)
	}
	switch {
	case !eventTime.Before(d.windowStart):
		d.exact[key] = struct{}{}
	default:
		if l := d.layerForLocked(eventTime); l != nil {
			l.filter.add(key)
		}
		// Beyond retention the index is the only record, which is
		// sufficient: any replay of this event is also beyond retention
		// and will consult the index.
	}
	return false, nil
}

// beyondRetentionLocked reports whether eventTime is older than the oldest
// window still held in memory.
func (d *Deduper) beyondRetentionLocked(eventTime time.Time) bool {
	oldest := d.windowStart
	if len(d.layers) > 0 {
		oldest = d.layers[0].windowStart
	}
	return eventTime.Before(oldest)
}

// layerForLocked returns the sealed layer containing eventTime, or nil if
// none does.
func (d *Deduper) layerForLocked(eventTime time.Time) *layer {
	if len(d.layers) == 0 {
		return nil
	}
	idx := int(eventTime.Sub(d.layers[0].windowStart) / d.cfg.WindowSize)
	if idx < 0 || idx >= len(d.layers) {
		return nil
	}
	return &d.layers[idx]
}

// Stats is a point-in-time view of the Deduper.
type Stats struct {
	Watermark   time.Time
	WindowStart time.Time
	ExactSize   int
	Layers      int
	OldestLayer time.Time
}

// Stats returns a snapshot of the component's structure.
func (d *Deduper) Stats() Stats {
	d.mu.Lock()
	defer d.mu.Unlock()
	s := Stats{
		Watermark:   d.watermark,
		WindowStart: d.windowStart,
		ExactSize:   len(d.exact),
		Layers:      len(d.layers),
	}
	if len(d.layers) > 0 {
		s.OldestLayer = d.layers[0].windowStart
	}
	return s
}
