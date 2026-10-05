// Package seglib implements a message segment log with per-consumer
// acknowledgement tracking.
//
// Semantics:
//   - Each consumer's acknowledged offsets form an interval set; the
//     consumer's position is the contiguous acked prefix starting at its
//     registration offset. Out-of-order acks are remembered but only
//     advance the position once the gap fills.
//   - Cancelling a consumer writes a persistent exit record. Reopening
//     the store (restart) reloads the records, so a cancelled consumer
//     can never be re-registered and its retention point is never
//     resurrected.
//   - Segment reclamation drops whole segments whose end is at or below
//     the minimum contiguous prefix across all active consumers. With no
//     active consumers nothing is reclaimed.
//   - Replay yields the messages at or after a consumer's prefix from
//     the segments that survived reclamation.
package seglib

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

const exitFileName = "exited.json"

var (
	ErrConsumerExited = errors.New("seglib: consumer has a persistent exit record")
	ErrConsumerActive = errors.New("seglib: consumer already registered")
	ErrNoConsumer     = errors.New("seglib: unknown consumer")
)

// Message is a single log entry identified by its global offset.
type Message struct {
	Offset uint64
	Body   string
}

// Segment is a contiguous run of messages starting at Base.
type Segment struct {
	Base uint64
	Msgs []string
}

// ExitRecord is the durable tombstone left behind when a consumer is
// cancelled. It survives restarts and blocks re-registration.
type ExitRecord struct {
	Name        string `json:"name"`
	FinalPrefix uint64 `json:"final_prefix"`
}

type consumer struct {
	name   string
	start  uint64
	acks   intervalSet
	prefix uint64
}

// Store is the segment log. Segments and live consumers are in-memory;
// exit records are persisted under dir.
type Store struct {
	dir       string
	next      uint64
	segments  []Segment
	consumers map[string]*consumer
	exited    map[string]ExitRecord
}

// Open creates or reopens a store rooted at dir, loading any persistent
// exit records left by previous incarnations.
func Open(dir string) (*Store, error) {
	s := &Store{
		dir:       dir,
		consumers: make(map[string]*consumer),
		exited:    make(map[string]ExitRecord),
	}
	data, err := os.ReadFile(filepath.Join(dir, exitFileName))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return s, nil
		}
		return nil, err
	}
	var recs []ExitRecord
	if err := json.Unmarshal(data, &recs); err != nil {
		return nil, err
	}
	for _, r := range recs {
		s.exited[r.Name] = r
	}
	return s, nil
}

// Append adds a new segment holding bodies and returns its base offset.
func (s *Store) Append(bodies ...string) uint64 {
	base := s.next
	cp := make([]string, len(bodies))
	copy(cp, bodies)
	s.segments = append(s.segments, Segment{Base: base, Msgs: cp})
	s.next += uint64(len(bodies))
	return base
}

// Register attaches a consumer whose ack prefix starts at start.
func (s *Store) Register(name string, start uint64) error {
	if _, ok := s.exited[name]; ok {
		return ErrConsumerExited
	}
	if _, ok := s.consumers[name]; ok {
		return ErrConsumerActive
	}
	s.consumers[name] = &consumer{name: name, start: start, prefix: start}
	return nil
}

// Ack records one acknowledged offset and recomputes the consumer's
// contiguous prefix. Acks past a gap are buffered, not applied.
func (s *Store) Ack(name string, offset uint64) error {
	c, err := s.lookup(name)
	if err != nil {
		return err
	}
	c.acks.add(offset, offset+1)
	c.prefix = c.acks.contiguousPrefix(c.start)
	return nil
}

// Prefix returns the consumer's contiguous acked prefix.
func (s *Store) Prefix(name string) (uint64, error) {
	c, err := s.lookup(name)
	if err != nil {
		return 0, err
	}
	return c.prefix, nil
}

// Cancel detaches a consumer and persists its exit record atomically.
// The record survives restarts and permanently blocks re-registration.
func (s *Store) Cancel(name string) error {
	c, ok := s.consumers[name]
	if !ok {
		if _, exited := s.exited[name]; exited {
			return ErrConsumerExited
		}
		return ErrNoConsumer
	}
	delete(s.consumers, name)
	s.exited[name] = ExitRecord{Name: name, FinalPrefix: c.prefix}
	return s.persistExits()
}

// Exited reports the persistent exit record for name, if any.
func (s *Store) Exited(name string) (ExitRecord, bool) {
	r, ok := s.exited[name]
	return r, ok
}

// ReclaimBound is the minimum contiguous prefix across active consumers.
// The second result is false when no consumer is active.
func (s *Store) ReclaimBound() (uint64, bool) {
	var bound uint64
	ok := false
	for _, c := range s.consumers {
		if !ok || c.prefix < bound {
			bound, ok = c.prefix, true
		}
	}
	return bound, ok
}

// Reclaim drops whole segments ending at or below the reclaim bound and
// returns how many were dropped. It is a no-op without active consumers.
func (s *Store) Reclaim() int {
	bound, ok := s.ReclaimBound()
	if !ok {
		return 0
	}
	dropped := 0
	kept := s.segments[:0]
	for _, seg := range s.segments {
		if seg.Base+uint64(len(seg.Msgs)) <= bound {
			dropped++
			continue
		}
		kept = append(kept, seg)
	}
	for i := len(kept); i < len(s.segments); i++ {
		s.segments[i] = Segment{}
	}
	s.segments = kept
	return dropped
}

// Replay returns the surviving messages at or after the consumer's
// contiguous prefix, in offset order.
func (s *Store) Replay(name string) ([]Message, error) {
	c, err := s.lookup(name)
	if err != nil {
		return nil, err
	}
	var out []Message
	for _, seg := range s.segments {
		for i, body := range seg.Msgs {
			off := seg.Base + uint64(i)
			if off >= c.prefix {
				out = append(out, Message{Offset: off, Body: body})
			}
		}
	}
	return out, nil
}

// Segments exposes the surviving segments, oldest first.
func (s *Store) Segments() []Segment {
	out := make([]Segment, len(s.segments))
	copy(out, s.segments)
	return out
}

func (s *Store) lookup(name string) (*consumer, error) {
	if c, ok := s.consumers[name]; ok {
		return c, nil
	}
	if _, ok := s.exited[name]; ok {
		return nil, ErrConsumerExited
	}
	return nil, ErrNoConsumer
}

func (s *Store) persistExits() error {
	recs := make([]ExitRecord, 0, len(s.exited))
	for _, r := range s.exited {
		recs = append(recs, r)
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].Name < recs[j].Name })
	data, err := json.MarshalIndent(recs, "", "  ")
	if err != nil {
		return err
	}
	final := filepath.Join(s.dir, exitFileName)
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, final)
}
