// Package fakestore is an in-memory synclib.Store for tests. It can inject
// partial writes (only some fields/attachments land) and delayed read-back
// (writes become visible only after a consistency window).
package fakestore

import (
	"context"
	"sync"
	"time"

	"example.com/synclib"
)

// PartialWrite describes a fault injected on a specific write call.
type PartialWrite struct {
	// OnCall is the 1-based write call to corrupt; 0 corrupts every call.
	OnCall int
	// DropFields are field names omitted from the stored record.
	DropFields []string
	// DropAttachments are attachment names omitted from the stored record.
	DropAttachments []string
	// Err, if non-nil, is returned after the partial write is applied.
	Err error
}

type versioned struct {
	rec     synclib.Record
	receipt synclib.Receipt
}

type recordState struct {
	visible    versioned
	hasVisible bool
	pending    versioned
	hasPending bool
	visibleAt  time.Time
}

// Store is a fake in-memory Store.
type Store struct {
	mu      sync.Mutex
	clock   func() time.Time
	records map[string]*recordState
	version uint64
	writes  int

	// ConsistencyWindow delays visibility of each write to reads.
	ConsistencyWindow time.Duration
	// Partials are partial-write faults, applied in order of OnCall match.
	Partials []PartialWrite
}

var _ synclib.Store = (*Store)(nil)

// New returns an empty Store using the real clock.
func New() *Store {
	return &Store{clock: time.Now, records: make(map[string]*recordState)}
}

// SetClock overrides the time source, e.g. for a manually advanced clock.
func (s *Store) SetClock(clock func() time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clock = clock
}

// WriteCalls reports how many writes have been attempted.
func (s *Store) WriteCalls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writes
}

func (s *Store) Write(ctx context.Context, rec synclib.Record) (synclib.Receipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writes++
	s.version++
	stored := rec
	var retErr error
	for _, p := range s.Partials {
		if p.OnCall == 0 || p.OnCall == s.writes {
			stored = dropFields(stored, p.DropFields)
			stored = dropAttachments(stored, p.DropAttachments)
			if p.Err != nil {
				retErr = p.Err
			}
		}
	}
	receipt := synclib.Receipt{ID: rec.ID, Version: s.version, WrittenAt: s.clock()}
	st := s.records[rec.ID]
	if st == nil {
		st = &recordState{}
		s.records[rec.ID] = st
	}
	v := versioned{rec: cloneRecord(stored), receipt: receipt}
	if s.ConsistencyWindow <= 0 {
		st.visible, st.hasVisible = v, true
		st.hasPending = false
	} else {
		st.pending, st.hasPending = v, true
		st.visibleAt = s.clock().Add(s.ConsistencyWindow)
	}
	return receipt, retErr
}

func (s *Store) Read(ctx context.Context, id string) (synclib.Record, synclib.Receipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.records[id]
	if st == nil {
		return synclib.Record{}, synclib.Receipt{}, synclib.ErrNotFound
	}
	if st.hasPending && !s.clock().Before(st.visibleAt) {
		st.visible, st.hasVisible = st.pending, true
		st.hasPending = false
	}
	if !st.hasVisible {
		return synclib.Record{}, synclib.Receipt{}, synclib.ErrNotFound
	}
	return cloneRecord(st.visible.rec), st.visible.receipt, nil
}

func dropFields(rec synclib.Record, names []string) synclib.Record {
	out := cloneRecord(rec)
	for _, n := range names {
		delete(out.Fields, n)
	}
	return out
}

func dropAttachments(rec synclib.Record, names []string) synclib.Record {
	out := cloneRecord(rec)
	drop := make(map[string]bool, len(names))
	for _, n := range names {
		drop[n] = true
	}
	kept := out.Attachments[:0]
	for _, a := range out.Attachments {
		if !drop[a.Name] {
			kept = append(kept, a)
		}
	}
	out.Attachments = kept
	return out
}

func cloneRecord(r synclib.Record) synclib.Record {
	out := synclib.Record{ID: r.ID}
	if r.Fields != nil {
		out.Fields = make(map[string]string, len(r.Fields))
		for k, v := range r.Fields {
			out.Fields[k] = v
		}
	}
	if r.Attachments != nil {
		out.Attachments = make([]synclib.Attachment, len(r.Attachments))
		for i, a := range r.Attachments {
			data := make([]byte, len(a.Data))
			copy(data, a.Data)
			out.Attachments[i] = synclib.Attachment{Name: a.Name, Data: data}
		}
	}
	return out
}
