// Package dedup implements event-time bounded deduplication for stream
// consumers. Keys are retained only within a bounded event-time window;
// the window is advanced by a watermark derived from observed event
// times. Events arriving later than the retention bound are rejected
// instead of being treated as new, and a key reseen with a different
// payload inside the window is reported as a conflict.
//
// The watermark and the live key window can be snapshotted and restored,
// so a restart resumes with identical dedup decisions.
package dedup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
)

// Result is the outcome of ingesting one event.
type Result int

const (
	// ResultNew means the key was not present in the live window and has been
	// recorded.
	ResultNew Result = iota
	// ResultDuplicate means the key was already present with the same payload.
	ResultDuplicate
	// ResultConflict means the key was already present with a different payload.
	ResultConflict
	// ResultLate means the event time is at or beyond the retention bound
	// (event time <= watermark-retention); the event is rejected and
	// never treated as new.
	ResultLate
)

func (r Result) String() string {
	switch r {
	case ResultNew:
		return "New"
	case ResultDuplicate:
		return "Duplicate"
	case ResultConflict:
		return "Conflict"
	case ResultLate:
		return "Late"
	}
	return "Unknown"
}

// Event is a single record to deduplicate. Time is the event time used
// for watermarking; Payload is hashed with SHA-256 for identity.
type Event struct {
	Key     string
	Payload []byte
	Time    int64
}

type entry struct {
	Time int64
	Hash [sha256.Size]byte
}

// Deduper keeps dedup keys for a bounded event-time window.
//
// The watermark is the maximum event time observed so far and only moves
// forward. A key is evicted once its event time falls to or below
// watermark-retention. An event with time <= watermark-retention is
// rejected as Late and changes no state.
type Deduper struct {
	retention int64
	watermark int64
	started   bool
	entries   map[string]entry
}

// New returns a Deduper retaining keys while their event time is greater
// than watermark-retention. retention must be positive.
func New(retention int64) (*Deduper, error) {
	if retention <= 0 {
		return nil, fmt.Errorf("dedup: retention must be positive, got %d", retention)
	}
	return &Deduper{retention: retention, entries: make(map[string]entry)}, nil
}

// Watermark reports the current watermark and whether any non-late event
// has been observed.
func (d *Deduper) Watermark() (int64, bool) {
	return d.watermark, d.started
}

// Retention reports the configured retention window.
func (d *Deduper) Retention() int64 {
	return d.retention
}

// Len reports the number of keys currently held in the live window.
func (d *Deduper) Len() int {
	return len(d.entries)
}

// Ingest classifies one event and updates the window.
func (d *Deduper) Ingest(e Event) Result {
	if d.started && e.Time <= d.watermark-d.retention {
		return ResultLate
	}
	if !d.started || e.Time > d.watermark {
		d.watermark = e.Time
		d.started = true
		d.evict()
	}
	h := sha256.Sum256(e.Payload)
	if cur, ok := d.entries[e.Key]; ok {
		if cur.Hash != h {
			return ResultConflict
		}
		return ResultDuplicate
	}
	d.entries[e.Key] = entry{Time: e.Time, Hash: h}
	return ResultNew
}

// evict drops keys whose event time is at or beyond the retention bound.
func (d *Deduper) evict() {
	cutoff := d.watermark - d.retention
	for k, v := range d.entries {
		if v.Time <= cutoff {
			delete(d.entries, k)
		}
	}
}

type snapshotEntry struct {
	Time int64  `json:"time"`
	Hash string `json:"hash"`
}

type snapshot struct {
	Retention int64                    `json:"retention"`
	Watermark int64                    `json:"watermark"`
	Started   bool                     `json:"started"`
	Entries   map[string]snapshotEntry `json:"entries"`
}

// Snapshot serializes the watermark and the live key window to w, so a
// restarted consumer resumes with identical dedup decisions.
func (d *Deduper) Snapshot(w io.Writer) error {
	s := snapshot{
		Retention: d.retention,
		Watermark: d.watermark,
		Started:   d.started,
		Entries:   make(map[string]snapshotEntry, len(d.entries)),
	}
	for k, v := range d.entries {
		s.Entries[k] = snapshotEntry{Time: v.Time, Hash: hex.EncodeToString(v.Hash[:])}
	}
	return json.NewEncoder(w).Encode(s)
}

// Restore rebuilds a Deduper from a snapshot produced by Snapshot.
func Restore(r io.Reader) (*Deduper, error) {
	var s snapshot
	if err := json.NewDecoder(r).Decode(&s); err != nil {
		return nil, fmt.Errorf("dedup: decode snapshot: %w", err)
	}
	if s.Retention <= 0 {
		return nil, fmt.Errorf("dedup: snapshot has non-positive retention %d", s.Retention)
	}
	d := &Deduper{
		retention: s.Retention,
		watermark: s.Watermark,
		started:   s.Started,
		entries:   make(map[string]entry, len(s.Entries)),
	}
	for k, v := range s.Entries {
		raw, err := hex.DecodeString(v.Hash)
		if err != nil {
			return nil, fmt.Errorf("dedup: snapshot entry %q: %w", k, err)
		}
		if len(raw) != sha256.Size {
			return nil, fmt.Errorf("dedup: snapshot entry %q: hash is %d bytes, want %d", k, len(raw), sha256.Size)
		}
		var h [sha256.Size]byte
		copy(h[:], raw)
		d.entries[k] = entry{Time: v.Time, Hash: h}
	}
	return d, nil
}
