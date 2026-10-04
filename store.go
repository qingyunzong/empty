// Package seglog implements a message-segment log with per-consumer
// acknowledged-interval tracking, persistent cancel tombstones, and
// prefix-based segment reclamation.
package seglog

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"sync"
)

// ErrConsumerCancelled is returned when an ack targets a consumer that
// has been cancelled. The cancel tombstone is permanent: restarting the
// store never resurrects the consumer's retained position.
var ErrConsumerCancelled = errors.New("seglog: consumer cancelled")

// ErrSegmentOutOfRange is returned when an ack names a segment index
// that has not been appended yet.
var ErrSegmentOutOfRange = errors.New("seglog: segment index out of range")

// opRecord is one entry in the write-ahead log. Replaying the records in
// order rebuilds the exact in-memory state.
type opRecord struct {
	Op       string `json:"op"` // "append", "ack", "cancel", "reclaim"
	Consumer string `json:"consumer,omitempty"`
	ID       int    `json:"id,omitempty"`
	N        int    `json:"n,omitempty"`
}

type consumerState struct {
	cancelled bool
	acks      intervalSet
}

// Store tracks appended segments and each consumer's acknowledged
// intervals. All state changes are appended to a WAL file so a restart
// replays them; cancel tombstones in the WAL keep cancelled consumers
// from being resurrected.
type Store struct {
	mu        sync.Mutex
	wal       *os.File
	enc       *json.Encoder
	segments  int // total appended segment count
	base      int // reclaimed prefix: segments [0, base) are gone
	consumers map[string]*consumerState
}

// Open creates or replays the store persisted at path.
func Open(path string) (*Store, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	s := &Store{wal: f, consumers: make(map[string]*consumerState)}
	dec := json.NewDecoder(f)
	for {
		var rec opRecord
		err := dec.Decode(&rec)
		if err == io.EOF {
			break
		}
		if err != nil {
			f.Close()
			return nil, fmt.Errorf("seglog: replaying %s: %w", path, err)
		}
		s.apply(rec)
	}
	s.enc = json.NewEncoder(f)
	return s, nil
}

// apply folds one WAL record into memory. It is used both for live
// operations and for replay after a restart.
func (s *Store) apply(rec opRecord) {
	switch rec.Op {
	case "append":
		s.segments += rec.N
	case "ack":
		c := s.consumer(rec.Consumer)
		if c.cancelled {
			return
		}
		if rec.ID < s.base || rec.ID >= s.segments {
			return
		}
		c.acks.add(rec.ID)
	case "cancel":
		c := s.consumer(rec.Consumer)
		c.cancelled = true
		c.acks = intervalSet{} // the retained position is discarded for good
	case "reclaim":
		if rec.N > s.base {
			s.base = rec.N
			for _, c := range s.consumers {
				c.acks.dropBelow(s.base)
			}
		}
	}
}

func (s *Store) consumer(name string) *consumerState {
	c := s.consumers[name]
	if c == nil {
		c = &consumerState{}
		s.consumers[name] = c
	}
	return c
}

// log appends rec to the WAL and folds it into memory.
func (s *Store) log(rec opRecord) error {
	if err := s.enc.Encode(rec); err != nil {
		return err
	}
	if err := s.wal.Sync(); err != nil {
		return err
	}
	s.apply(rec)
	return nil
}

// Append adds n new segments to the log and returns the index of the
// first new segment.
func (s *Store) Append(n int) (int, error) {
	if n <= 0 {
		return 0, fmt.Errorf("seglog: append count must be positive, got %d", n)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	first := s.segments
	if err := s.log(opRecord{Op: "append", N: n}); err != nil {
		return 0, err
	}
	return first, nil
}

// Ack records that consumer acknowledged segment id. Acks may arrive out
// of order; only the contiguous prefix ever advances. Acking an already
// reclaimed id is a no-op.
func (s *Store) Ack(consumer string, id int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c := s.consumers[consumer]; c != nil && c.cancelled {
		return ErrConsumerCancelled
	}
	if id >= s.segments {
		return ErrSegmentOutOfRange
	}
	if id < s.base {
		return nil
	}
	return s.log(opRecord{Op: "ack", Consumer: consumer, ID: id})
}

// Cancel permanently retires consumer, writing a tombstone to the WAL.
// The consumer's retained position is discarded and excluded from
// reclamation; replaying the WAL after a restart keeps it cancelled.
func (s *Store) Cancel(consumer string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c := s.consumers[consumer]; c != nil && c.cancelled {
		return nil
	}
	return s.log(opRecord{Op: "cancel", Consumer: consumer})
}

// Cancelled reports whether consumer has a cancel tombstone.
func (s *Store) Cancelled(consumer string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.consumers[consumer]
	return c != nil && c.cancelled
}

// Prefix returns the consumer's contiguous acknowledged prefix as an
// absolute segment index: every segment in [Base(), Prefix) is covered.
// Unknown or cancelled consumers retain nothing beyond Base().
func (s *Store) Prefix(consumer string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.consumers[consumer]
	if c == nil || c.cancelled {
		return s.base
	}
	return c.acks.prefix(s.base)
}

// Base returns the reclamation watermark: segments [0, Base) are gone.
func (s *Store) Base() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.base
}

// Segments returns the total number of appended segments.
func (s *Store) Segments() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.segments
}

// ActiveConsumers lists consumers that are not cancelled, sorted.
func (s *Store) ActiveConsumers() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var names []string
	for name, c := range s.consumers {
		if !c.cancelled {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// Reclaim drops every segment below the minimum contiguous prefix of all
// active consumers and returns the new base. Cancelled consumers do not
// hold anything back. With no active consumers nothing is reclaimed.
func (s *Store) Reclaim() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	min := s.segments
	active := false
	for _, c := range s.consumers {
		if c.cancelled {
			continue
		}
		active = true
		if p := c.acks.prefix(s.base); p < min {
			min = p
		}
	}
	if !active || min <= s.base {
		return s.base, nil
	}
	if err := s.log(opRecord{Op: "reclaim", N: min}); err != nil {
		return 0, err
	}
	return s.base, nil
}

// Close flushes and closes the underlying WAL file.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.wal == nil {
		return nil
	}
	err := s.wal.Close()
	s.wal = nil
	return err
}
