// Package dedup implements a consumer-side deduplication store that retains
// dedup keys only for a bounded event-time window. Eviction is driven by a
// monotonically increasing watermark: once the watermark passes a key's event
// time by more than the configured window, the key is forgotten. Events
// arriving later than the eviction horizon are rejected as late instead of
// being treated as new, and a key reappearing with a different payload is
// reported as a conflict.
//
// The store can snapshot its watermark and key window to disk so that a
// restart resumes with identical dedup state.
package dedup

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Event is a single record arriving at the consumer.
type Event struct {
	Key       string // dedup key
	EventTime int64  // event-time timestamp (logical)
	Payload   []byte
}

// Verdict is the outcome of ingesting one event.
type Verdict int

const (
	// Accepted: first time this key was seen; payload recorded.
	Accepted Verdict = iota
	// Duplicate: key already retained with an identical payload.
	Duplicate
	// Conflict: key already retained with a different payload.
	Conflict
	// RejectedLate: event time is beyond the retention horizon
	// (EventTime <= watermark-window); the event is dropped, never
	// treated as new, and its key is not (re-)admitted.
	RejectedLate
)

func (v Verdict) String() string {
	switch v {
	case Accepted:
		return "Accepted"
	case Duplicate:
		return "Duplicate"
	case Conflict:
		return "Conflict"
	case RejectedLate:
		return "RejectedLate"
	}
	return "Unknown"
}

type entry struct {
	EventTime int64    `json:"eventTime"`
	Hash      [32]byte `json:"hash"` // sha256 of payload
}

type snapshot struct {
	Window       int64            `json:"window"`
	Watermark    int64            `json:"watermark"`
	HasWatermark bool             `json:"hasWatermark"`
	Entries      map[string]entry `json:"entries"`
}

// Store is a bounded event-time dedup store. It is safe for concurrent use.
type Store struct {
	mu           sync.Mutex
	window       int64
	watermark    int64
	hasWatermark bool
	keys         map[string]entry
	path         string // snapshot destination; "" disables persistence
}

// New returns an in-memory store retaining keys for window event-time units
// past the watermark.
func New(window int64) *Store {
	return &Store{window: window, keys: make(map[string]entry)}
}

// Open returns a store persisting to path. If path exists, the watermark and
// the retained key window are restored and window must match the persisted
// value; otherwise a fresh store is created and path will be written by Save.
func Open(path string, window int64) (*Store, error) {
	s := New(window)
	s.path = path
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	var snap snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, fmt.Errorf("dedup: corrupt snapshot %s: %w", path, err)
	}
	if snap.Window != window {
		return nil, fmt.Errorf("dedup: window mismatch: snapshot=%d requested=%d", snap.Window, window)
	}
	s.watermark = snap.Watermark
	s.hasWatermark = snap.HasWatermark
	s.keys = snap.Entries
	if s.keys == nil {
		s.keys = make(map[string]entry)
	}
	return s, nil
}

// cutoff is the retention horizon: events and keys at or below it are out of
// the window.
func (s *Store) cutoff() int64 {
	return s.watermark - s.window
}

// Ingest consumes one event and reports the verdict. Lateness is evaluated
// against the watermark before this event advances it.
func (s *Store) Ingest(ev Event) Verdict {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.hasWatermark && ev.EventTime <= s.cutoff() {
		return RejectedLate
	}
	s.advanceLocked(ev.EventTime)

	h := sha256.Sum256(ev.Payload)
	if e, ok := s.keys[ev.Key]; ok {
		if e.Hash == h {
			return Duplicate
		}
		return Conflict
	}
	s.keys[ev.Key] = entry{EventTime: ev.EventTime, Hash: h}
	return Accepted
}

// AdvanceWatermark moves the watermark forward to t (never backward) and
// evicts retained keys whose event time fell out of the window.
func (s *Store) AdvanceWatermark(t int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.advanceLocked(t)
}

func (s *Store) advanceLocked(t int64) {
	if s.hasWatermark && t <= s.watermark {
		return
	}
	s.watermark = t
	s.hasWatermark = true
	s.evictLocked()
}

func (s *Store) evictLocked() {
	c := s.cutoff()
	for k, e := range s.keys {
		if e.EventTime <= c {
			delete(s.keys, k)
		}
	}
}

// Watermark reports the current watermark and whether one has been set.
func (s *Store) Watermark() (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.watermark, s.hasWatermark
}

// Len reports how many dedup keys are currently retained.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.keys)
}

// Save atomically snapshots the watermark and the retained key window to the
// store's path. It is a no-op for stores created with New.
func (s *Store) Save() error {
	s.mu.Lock()
	snap := snapshot{
		Window:       s.window,
		Watermark:    s.watermark,
		HasWatermark: s.hasWatermark,
		Entries:      s.keys,
	}
	path := s.path
	s.mu.Unlock()

	if path == "" {
		return nil
	}
	data, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".dedup-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}
