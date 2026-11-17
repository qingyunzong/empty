package formal

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

var (
	// ErrInvalidBucketWidth is returned when a bucket width is not positive.
	ErrInvalidBucketWidth = errors.New("formal: bucket width must be positive")
	// ErrInvalidBucket is returned when bucket counts are inconsistent.
	ErrInvalidBucket = errors.New("formal: invalid bucket")
	// ErrBucketAlignment is returned when a bucket start is not on the grid.
	ErrBucketAlignment = errors.New("formal: bucket start is not aligned to bucket width")
)

// Bucket is the aggregate SLI sample for [Start, Start+width).
//
// Total is the number of events and Errors is the number of events that
// violated the SLI. A bucket is a delta, not a cumulative counter.
type Bucket struct {
	Start  time.Time
	Total  int64
	Errors int64
}

// Validate reports whether b can be stored with the given width.
func (b Bucket) Validate(width time.Duration) error {
	if width <= 0 {
		return fmt.Errorf("%w: got %s", ErrInvalidBucketWidth, width)
	}
	if b.Start.IsZero() {
		return fmt.Errorf("%w: zero start time", ErrInvalidBucket)
	}
	if b.Total < 0 || b.Errors < 0 || b.Errors > b.Total {
		return fmt.Errorf("%w: total=%d errors=%d", ErrInvalidBucket, b.Total, b.Errors)
	}
	start := b.Start.UTC()
	if !start.Truncate(width).Equal(start) {
		return fmt.Errorf("%w: start=%s width=%s", ErrBucketAlignment, start.Format(time.RFC3339Nano), width)
	}
	return nil
}

func normalizeBucket(b Bucket, width time.Duration) (Bucket, error) {
	if err := b.Validate(width); err != nil {
		return Bucket{}, err
	}
	b.Start = b.Start.UTC()
	return b, nil
}

// Store is a concurrency-safe collection of interval buckets.
//
// Upserting the same start replaces the previous bucket, which makes retries
// idempotent and allows late corrections to backfill a gap.
type Store struct {
	mu       sync.RWMutex
	width    time.Duration
	buckets  map[int64]Bucket
	revision uint64
}

// NewStore creates an empty bucket store.
func NewStore(width time.Duration) (*Store, error) {
	if width <= 0 {
		return nil, fmt.Errorf("%w: got %s", ErrInvalidBucketWidth, width)
	}
	return &Store{
		width:   width,
		buckets: make(map[int64]Bucket),
	}, nil
}

// Width returns the bucket width used by the store.
func (s *Store) Width() time.Duration {
	return s.width
}

// Upsert inserts or replaces a bucket. It reports whether the stored value
// changed. An identical duplicate is a no-op and does not bump the revision.
func (s *Store) Upsert(b Bucket) (bool, error) {
	normalized, err := normalizeBucket(b, s.width)
	if err != nil {
		return false, err
	}
	key := normalized.Start.UnixNano()

	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.buckets[key]; ok &&
		old.Start.Equal(normalized.Start) &&
		old.Total == normalized.Total &&
		old.Errors == normalized.Errors {
		return false, nil
	}
	s.buckets[key] = normalized
	s.revision++
	return true, nil
}

// Get returns the bucket starting at start.
func (s *Store) Get(start time.Time) (Bucket, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	b, ok := s.buckets[start.UTC().UnixNano()]
	return b, ok
}

// Delete removes the bucket starting at start.
func (s *Store) Delete(start time.Time) bool {
	key := start.UTC().UnixNano()
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.buckets[key]; !ok {
		return false
	}
	delete(s.buckets, key)
	s.revision++
	return true
}

// Len returns the number of stored buckets.
func (s *Store) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.buckets)
}

// Revision returns a counter that changes whenever stored data changes.
func (s *Store) Revision() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.revision
}

// Latest returns the bucket with the greatest start time.
func (s *Store) Latest() (Bucket, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var latest Bucket
	found := false
	for _, b := range s.buckets {
		if !found || b.Start.After(latest.Start) {
			latest = b
			found = true
		}
	}
	return latest, found
}

// Buckets returns a snapshot ordered by start time.
func (s *Store) Buckets() []Bucket {
	s.mu.RLock()
	out := make([]Bucket, 0, len(s.buckets))
	for _, b := range s.buckets {
		out = append(out, b)
	}
	s.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Start.Before(out[j].Start) })
	return out
}

// PruneBefore removes buckets whose start is before t and returns the number
// removed. Backfill older than the retained range can therefore be rejected by
// the caller's retention policy.
func (s *Store) PruneBefore(t time.Time) int {
	cut := t.UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	removed := 0
	for key, b := range s.buckets {
		if b.Start.Before(cut) {
			delete(s.buckets, key)
			removed++
		}
	}
	if removed > 0 {
		s.revision++
	}
	return removed
}

type windowPoint struct {
	start   time.Time
	bucket  Bucket
	present bool
}

// points builds the exact bucket grid for [from, to) in one read lock. Both
// windows share the same cut, so the caller can slice the short window from
// the tail of the long window without another store lookup.
func (s *Store) points(from, to time.Time, width time.Duration) ([]windowPoint, uint64) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	count := int(to.Sub(from) / width)
	if count <= 0 {
		return nil, s.revision
	}
	points := make([]windowPoint, count)
	for i := 0; i < count; i++ {
		start := from.Add(time.Duration(i) * width)
		b, ok := s.buckets[start.UnixNano()]
		points[i] = windowPoint{start: start, bucket: b, present: ok}
	}
	return points, s.revision
}
