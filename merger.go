// Package streammerge merges multiple event streams into one globally
// ordered output using per-source watermarks.
//
// The output watermark is the minimum watermark across all non-idle
// sources; every buffered event with a timestamp at or below that
// watermark forms the safe prefix and is published in global order.
// A source that declares itself idle stops blocking the watermark.
// A source that recovers (leaves idle) resumes at the already-published
// watermark: any event it then delivers at or below the published
// watermark is late, so it is diverted into an isolation report instead
// of the output.
package streammerge

import (
	"fmt"
	"sort"
	"sync"
)

// Event is a single record from a source stream.
type Event struct {
	Source  string
	TS      int64
	Seq     int64 // per-source sequence, breaks ties deterministically
	Payload string
}

// IsolatedEvent is a late event diverted away from the output.
type IsolatedEvent struct {
	Event     Event
	Reason    string
	Published int64 // published watermark at isolation time
}

type sourceState struct {
	idle         bool
	watermark    int64
	hasWatermark bool
}

// Merger merges event streams. It is safe for concurrent use.
type Merger struct {
	mu        sync.Mutex
	sources   map[string]*sourceState
	pending   []Event
	published int64
	out       []Event
	isolated  []IsolatedEvent
}

// New returns an empty Merger with a published watermark of -1.
func New() *Merger {
	return &Merger{
		sources:   make(map[string]*sourceState),
		published: -1,
	}
}

// AddSource registers a source. A new source is active and has not
// reported a watermark, so it blocks watermark progress until it calls
// Advance or is set idle.
func (m *Merger) AddSource(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.sources[id]; !ok {
		m.sources[id] = &sourceState{}
	}
}

// SetIdle marks a source idle (it stops blocking the watermark) or
// active again. Reactivating a source is a recovery: its watermark
// resumes at the published watermark so it can never drag the global
// watermark backwards.
func (m *Merger) SetIdle(id string, idle bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sources[id]
	if !ok {
		return fmt.Errorf("streammerge: unknown source %q", id)
	}
	s.idle = idle
	if !idle {
		s.watermark = m.published
		s.hasWatermark = true
	}
	m.drainLocked()
	return nil
}

// Advance moves a source's watermark forward and publishes any safe
// prefix it unblocks. Watermarks must be monotonic per source.
func (m *Merger) Advance(id string, watermark int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sources[id]
	if !ok {
		return fmt.Errorf("streammerge: unknown source %q", id)
	}
	if s.hasWatermark && watermark < s.watermark {
		return fmt.Errorf("streammerge: source %q watermark regressed from %d to %d", id, s.watermark, watermark)
	}
	s.watermark = watermark
	s.hasWatermark = true
	m.drainLocked()
	return nil
}

// Push delivers an event from a source. Events at or below the
// already-published watermark are late: they are diverted to the
// isolation report and never reach the output.
func (m *Merger) Push(ev Event) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.sources[ev.Source]; !ok {
		return fmt.Errorf("streammerge: unknown source %q", ev.Source)
	}
	if ev.TS <= m.published {
		m.isolated = append(m.isolated, IsolatedEvent{
			Event:     ev,
			Reason:    fmt.Sprintf("event TS %d at or below published watermark %d", ev.TS, m.published),
			Published: m.published,
		})
		return nil
	}
	m.pending = append(m.pending, ev)
	m.drainLocked()
	return nil
}

// Watermark returns the current published watermark.
func (m *Merger) Watermark() int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.published
}

// Output returns the published safe prefix in global order.
func (m *Merger) Output() []Event {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Event(nil), m.out...)
}

// Isolated returns the isolation report of diverted late events.
func (m *Merger) Isolated() []IsolatedEvent {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]IsolatedEvent(nil), m.isolated...)
}

// effectiveWatermarkLocked is the minimum watermark over non-idle
// sources. An active source that has never reported blocks progress;
// if every source is idle the watermark cannot advance.
func (m *Merger) effectiveWatermarkLocked() (int64, bool) {
	first := true
	var min int64
	for _, s := range m.sources {
		if s.idle {
			continue
		}
		if !s.hasWatermark {
			return 0, false
		}
		if first || s.watermark < min {
			min = s.watermark
			first = false
		}
	}
	if first {
		return 0, false
	}
	return min, true
}

// drainLocked publishes the safe prefix up to the effective watermark.
func (m *Merger) drainLocked() {
	wm, ok := m.effectiveWatermarkLocked()
	if !ok || wm <= m.published {
		return
	}
	m.published = wm
	kept := m.pending[:0]
	var ready []Event
	for _, ev := range m.pending {
		if ev.TS <= wm {
			ready = append(ready, ev)
		} else {
			kept = append(kept, ev)
		}
	}
	m.pending = kept
	sort.Slice(ready, func(i, j int) bool {
		if ready[i].TS != ready[j].TS {
			return ready[i].TS < ready[j].TS
		}
		if ready[i].Source != ready[j].Source {
			return ready[i].Source < ready[j].Source
		}
		return ready[i].Seq < ready[j].Seq
	})
	m.out = append(m.out, ready...)
}
