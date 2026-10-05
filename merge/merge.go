// Package merge implements a watermark-based stream merger.
//
// The merger tracks a watermark per source. The safe output prefix is
// derived from the minimum watermark across all non-idle sources: events
// at or below that bound may be published in globally monotonic order.
// Sources declared idle are excluded from the watermark computation and
// therefore never block the prefix. A recovered source must not deliver
// events below the already published watermark; such events are
// quarantined and reported instead of being emitted.
package merge

import (
	"fmt"
	"sort"
	"sync"
)

// Event is a single record flowing through the merger.
type Event struct {
	Source  string
	TS      int64
	Payload string
}

// IsolationRecord describes an event that was quarantined instead of
// being published.
type IsolationRecord struct {
	Event              Event
	PublishedWatermark int64
	Reason             string
}

// ReplayReport summarizes a virtual replay verification pass.
type ReplayReport struct {
	EventsReplayed   int
	Monotonic        bool
	IsolationIntact  bool
	FirstViolationTS int64 // meaningful only when Monotonic is false
	LeakedEvents     []Event
}

type sourceState struct {
	watermark int64
	idle      bool
}

// Merger merges events from multiple sources into a safe, globally
// monotonic prefix.
type Merger struct {
	mu                 sync.Mutex
	sources            map[string]*sourceState
	pending            []Event
	published          []Event
	publishedWatermark int64
	quarantine         []Event
	records            []IsolationRecord
}

// NewMerger returns an empty merger. The published watermark starts at
// the zero value of int64.
func NewMerger() *Merger {
	return &Merger{sources: make(map[string]*sourceState)}
}

// AddSource registers a source. It starts active with a zero watermark.
func (m *Merger) AddSource(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.sources[name]; ok {
		return fmt.Errorf("merge: source %q already registered", name)
	}
	m.sources[name] = &sourceState{}
	return nil
}

// Emit delivers an event from a source. Events whose timestamp is below
// the already published watermark are quarantined and reported; they
// never enter the output stream.
func (m *Merger) Emit(ev Event) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.sources[ev.Source]; !ok {
		return fmt.Errorf("merge: unknown source %q", ev.Source)
	}
	if ev.TS < m.publishedWatermark {
		m.quarantine = append(m.quarantine, ev)
		m.records = append(m.records, IsolationRecord{
			Event:              ev,
			PublishedWatermark: m.publishedWatermark,
			Reason:             "event timestamp below published watermark",
		})
		return nil
	}
	m.pending = append(m.pending, ev)
	return nil
}

// Advance moves a source's watermark forward and republishes the safe
// prefix. Watermarks never move backward.
func (m *Merger) Advance(name string, watermark int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	src, ok := m.sources[name]
	if !ok {
		return fmt.Errorf("merge: unknown source %q", name)
	}
	if watermark > src.watermark {
		src.watermark = watermark
	}
	m.publishLocked()
	return nil
}

// DeclareIdle marks a source idle. Idle sources are excluded from the
// minimum-watermark computation, so they cannot block the safe prefix.
func (m *Merger) DeclareIdle(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	src, ok := m.sources[name]
	if !ok {
		return fmt.Errorf("merge: unknown source %q", name)
	}
	src.idle = true
	m.publishLocked()
	return nil
}

// Recover marks an idle source active again. Its watermark restarts at
// the published watermark, so any event it delivers below that bound is
// quarantined and reported.
func (m *Merger) Recover(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	src, ok := m.sources[name]
	if !ok {
		return fmt.Errorf("merge: unknown source %q", name)
	}
	src.idle = false
	if src.watermark < m.publishedWatermark {
		src.watermark = m.publishedWatermark
	}
	return nil
}

// minActiveWatermarkLocked returns the minimum watermark across non-idle
// sources, and whether any non-idle source exists.
func (m *Merger) minActiveWatermarkLocked() (int64, bool) {
	var min int64
	found := false
	for _, src := range m.sources {
		if src.idle {
			continue
		}
		if !found || src.watermark < min {
			min = src.watermark
			found = true
		}
	}
	return min, found
}

// publishLocked emits every pending event at or below the safe bound in
// globally monotonic (timestamp, source) order.
func (m *Merger) publishLocked() {
	bound, ok := m.minActiveWatermarkLocked()
	if !ok {
		return
	}
	rest := m.pending[:0]
	var ready []Event
	for _, ev := range m.pending {
		if ev.TS <= bound {
			ready = append(ready, ev)
		} else {
			rest = append(rest, ev)
		}
	}
	m.pending = rest
	sort.SliceStable(ready, func(i, j int) bool {
		if ready[i].TS != ready[j].TS {
			return ready[i].TS < ready[j].TS
		}
		return ready[i].Source < ready[j].Source
	})
	for _, ev := range ready {
		if ev.TS < m.publishedWatermark {
			// Defensive: Emit already filters these, keep the output
			// monotonic even if pending was mutated elsewhere.
			m.quarantine = append(m.quarantine, ev)
			m.records = append(m.records, IsolationRecord{
				Event:              ev,
				PublishedWatermark: m.publishedWatermark,
				Reason:             "event timestamp below published watermark",
			})
			continue
		}
		m.published = append(m.published, ev)
		m.publishedWatermark = ev.TS
	}
}

// Published returns the safe prefix emitted so far, in publish order.
func (m *Merger) Published() []Event {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Event(nil), m.published...)
}

// PublishedWatermark returns the highest timestamp published so far.
func (m *Merger) PublishedWatermark() int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.publishedWatermark
}

// Quarantine returns the events held in isolation.
func (m *Merger) Quarantine() []Event {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Event(nil), m.quarantine...)
}

// IsolationReport returns the report of quarantined events.
func (m *Merger) IsolationReport() []IsolationRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]IsolationRecord(nil), m.records...)
}

// Replay performs a virtual replay of the full accepted event log
// (published plus still-pending events) and verifies two invariants:
// the published prefix is globally monotonic in timestamp, and the
// isolation scope holds, i.e. no quarantined event leaked into the
// published output.
func (m *Merger) Replay() ReplayReport {
	m.mu.Lock()
	defer m.mu.Unlock()
	rep := ReplayReport{Monotonic: true, IsolationIntact: true}
	rep.EventsReplayed = len(m.published) + len(m.pending)
	var last int64
	for i, ev := range m.published {
		if i > 0 && ev.TS < last {
			rep.Monotonic = false
			rep.FirstViolationTS = ev.TS
			break
		}
		last = ev.TS
	}
	quarantined := make(map[Event]struct{}, len(m.quarantine))
	for _, ev := range m.quarantine {
		quarantined[ev] = struct{}{}
	}
	for _, ev := range m.published {
		if _, bad := quarantined[ev]; bad {
			rep.IsolationIntact = false
			rep.LeakedEvents = append(rep.LeakedEvents, ev)
		}
	}
	return rep
}
