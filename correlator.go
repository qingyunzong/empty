package dataeng

import (
	"bytes"
	"errors"
	"fmt"
	"sort"
	"sync"
)

// Sentinel errors returned by the Correlator. Calls that fail with these
// errors never mutate component state.
var (
	// ErrDuplicateID is returned when an observation ID is reused with
	// different content.
	ErrDuplicateID = errors.New("dataeng: observation id reused with different content")

	// ErrOverlap is returned when a configuration interval overlaps an
	// existing interval for the same device, or when an existing interval is
	// re-delivered with different content.
	ErrOverlap = errors.New("dataeng: overlapping or revised configuration interval")

	// ErrWatermark is returned when an input falls behind the relevant
	// watermark, or when a watermark is advanced backwards.
	ErrWatermark = errors.New("dataeng: watermark violation")

	// ErrInvalidInterval is returned when a configuration interval is empty
	// or reversed. Intervals are half-open [Start, End) and require End > Start.
	ErrInvalidInterval = errors.New("dataeng: configuration interval must satisfy End > Start")
)

// Observation is a single telemetry event. ID is globally unique.
type Observation struct {
	ID        string
	DeviceID  string
	EventTime int64
	Payload   []byte
}

// ConfigInterval is a half-open [Start, End) configuration validity window
// for a device. Intervals of the same device never overlap; touching windows
// ([a, b) followed by [b, c)) are allowed.
type ConfigInterval struct {
	DeviceID string
	Start    int64
	End      int64 // exclusive
	Payload  []byte
}

// Result is delivered to the emit callback. Matched is false (and Config is
// nil) when no configuration interval covers the observation's device and
// event time.
type Result struct {
	Observation Observation
	Matched     bool
	Config      *ConfigInterval
}

// EmitFunc is the output callback. It must be idempotent for a given
// observation ID: the component may invoke it repeatedly for the same ID
// until it returns nil. A non-nil return means failure or an unknown outcome;
// the observation is retained and the caller may retry via Flush. The caller
// is responsible for deduplicating external side effects.
//
// EmitFunc must not call back into the Correlator that invoked it.
type EmitFunc func(Result) error

// EmitError wraps a callback failure together with the observation ID that
// failed. It unwraps to the original callback error.
type EmitError struct {
	ObservationID string
	Err           error
}

func (e *EmitError) Error() string {
	return fmt.Sprintf("dataeng: emit callback failed for observation %q: %v", e.ObservationID, e.Err)
}

func (e *EmitError) Unwrap() error { return e.Err }

// Correlator ingests observations and per-device configuration intervals and
// emits, in deterministic order, each observation together with the
// configuration interval covering it once both watermarks have passed it.
//
// All methods are safe for concurrent use. The emit callback runs while the
// Correlator lock is held, so callback implementations must not re-enter the
// Correlator.
type Correlator struct {
	mu sync.Mutex

	emit EmitFunc

	// Pending observations keyed by ID.
	observations map[string]Observation

	// Observations already emitted successfully, retained so re-delivery of
	// the same ID and content stays idempotent for the full input lifecycle.
	emitted map[string]Observation

	// Configuration intervals per device, kept sorted by Start and mutually
	// non-overlapping.
	configs map[string][]ConfigInterval

	hasObservationWatermark bool
	observationWatermark    int64

	hasConfigWatermark bool
	configWatermark    int64
}

// NewCorrelator creates a Correlator using emit for output. It panics if emit
// is nil.
func NewCorrelator(emit EmitFunc) *Correlator {
	if emit == nil {
		panic("dataeng: nil emit callback")
	}
	return &Correlator{
		emit:         emit,
		observations: make(map[string]Observation),
		emitted:      make(map[string]Observation),
		configs:      make(map[string][]ConfigInterval),
	}
}

// AddObservation ingests an observation. Re-delivery of the same ID with the
// same content is ignored; the same ID with different content returns
// ErrDuplicateID and leaves state unchanged. An observation whose EventTime is
// below the observation watermark returns ErrWatermark.
func (c *Correlator) AddObservation(o Observation) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if existing, ok := c.observations[o.ID]; ok {
		if sameObservation(existing, o) {
			return nil
		}
		return ErrDuplicateID
	}
	if prior, ok := c.emitted[o.ID]; ok {
		if sameObservation(prior, o) {
			return nil
		}
		return ErrDuplicateID
	}
	if c.hasObservationWatermark && o.EventTime < c.observationWatermark {
		return ErrWatermark
	}

	c.observations[o.ID] = cloneObservation(o)
	return c.pumpLocked()
}

// AddConfig ingests a configuration interval, which may arrive out of order.
// Re-delivery of the identical interval (same device, bounds and payload) is
// ignored. Overlapping intervals, or re-delivery of the same bounds with
// different content, return ErrOverlap; intervals whose Start is below the
// configuration watermark return ErrWatermark. Malformed intervals return
// ErrInvalidInterval. In every error case state is unchanged.
func (c *Correlator) AddConfig(in ConfigInterval) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if in.End <= in.Start {
		return ErrInvalidInterval
	}

	intervals := c.configs[in.DeviceID]
	insertAt := sort.Search(len(intervals), func(i int) bool {
		return intervals[i].Start >= in.Start
	})

	for _, idx := range neighborIndexes(len(intervals), insertAt) {
		other := intervals[idx]
		if in.Start < other.End && other.Start < in.End {
			if other.Start == in.Start && other.End == in.End && bytes.Equal(other.Payload, in.Payload) {
				return nil
			}
			return ErrOverlap
		}
	}

	if c.hasConfigWatermark && in.Start < c.configWatermark {
		return ErrWatermark
	}

	entry := cloneConfig(in)
	intervals = append(intervals, ConfigInterval{})
	copy(intervals[insertAt+1:], intervals[insertAt:])
	intervals[insertAt] = entry
	c.configs[in.DeviceID] = intervals

	return c.pumpLocked()
}

// AdvanceObservationWatermark advances the observation watermark to w. The
// watermark is monotonic: a value below the current one returns ErrWatermark;
// an equal value is a no-op.
func (c *Correlator) AdvanceObservationWatermark(w int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.hasObservationWatermark && w < c.observationWatermark {
		return ErrWatermark
	}
	if !c.hasObservationWatermark || w > c.observationWatermark {
		c.hasObservationWatermark = true
		c.observationWatermark = w
	}
	return c.pumpLocked()
}

// AdvanceConfigWatermark advances the configuration watermark to w. The
// watermark is monotonic: a value below the current one returns ErrWatermark;
// an equal value is a no-op.
func (c *Correlator) AdvanceConfigWatermark(w int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.hasConfigWatermark && w < c.configWatermark {
		return ErrWatermark
	}
	if !c.hasConfigWatermark || w > c.configWatermark {
		c.hasConfigWatermark = true
		c.configWatermark = w
	}
	return c.pumpLocked()
}

// Flush retries emission of retained observations. It is used to retry the
// same observation IDs after a callback failure or unknown outcome, and is a
// no-op when nothing is currently eligible.
func (c *Correlator) Flush() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pumpLocked()
}

// Pending returns the number of observations retained because they have not
// yet been emitted successfully.
func (c *Correlator) Pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.observations)
}

// pumpLocked emits every observation whose EventTime is strictly below both
// watermarks, in event-time order, breaking ties by the UTF-8 byte order of
// the observation ID. Emission stops at the first callback failure.
func (c *Correlator) pumpLocked() error {
	if !c.hasObservationWatermark || !c.hasConfigWatermark {
		return nil
	}

	threshold := c.observationWatermark
	if c.configWatermark < threshold {
		threshold = c.configWatermark
	}

	ready := make([]Observation, 0, len(c.observations))
	for _, o := range c.observations {
		if o.EventTime < threshold {
			ready = append(ready, o)
		}
	}
	sort.Slice(ready, func(i, j int) bool {
		if ready[i].EventTime != ready[j].EventTime {
			return ready[i].EventTime < ready[j].EventTime
		}
		return ready[i].ID < ready[j].ID
	})

	for _, o := range ready {
		result := Result{Observation: cloneObservation(o)}
		if cfg := coveringConfig(c.configs[o.DeviceID], o.EventTime); cfg != nil {
			copyCfg := *cfg
			result.Matched = true
			result.Config = &copyCfg
		}
		if err := c.emit(result); err != nil {
			return &EmitError{ObservationID: o.ID, Err: err}
		}
		delete(c.observations, o.ID)
		c.emitted[o.ID] = o
	}
	return nil
}

// coveringConfig returns the unique interval containing t, or nil. Intervals
// are sorted and non-overlapping, so only the last interval starting at or
// before t can cover it.
func coveringConfig(intervals []ConfigInterval, t int64) *ConfigInterval {
	i := sort.Search(len(intervals), func(i int) bool {
		return intervals[i].Start > t
	}) - 1
	if i >= 0 && intervals[i].End > t {
		return &intervals[i]
	}
	return nil
}

func neighborIndexes(length, insertAt int) []int {
	var indexes []int
	if insertAt > 0 {
		indexes = append(indexes, insertAt-1)
	}
	if insertAt < length {
		indexes = append(indexes, insertAt)
	}
	return indexes
}

func sameObservation(a, b Observation) bool {
	return a.ID == b.ID &&
		a.DeviceID == b.DeviceID &&
		a.EventTime == b.EventTime &&
		bytes.Equal(a.Payload, b.Payload)
}

func cloneObservation(o Observation) Observation {
	o.Payload = cloneBytes(o.Payload)
	return o
}

func cloneConfig(in ConfigInterval) ConfigInterval {
	in.Payload = cloneBytes(in.Payload)
	return in
}

func cloneBytes(b []byte) []byte {
	if b == nil {
		return nil
	}
	out := make([]byte, len(b))
	copy(out, b)
	return out
}
