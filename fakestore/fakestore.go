// Package fakestore provides an in-memory fieldsync.Store with fault
// injection: partial writes (via TransformWrite) and delayed read-back
// consistency (via ReadLag), plus operation counters for assertions.
package fakestore

import (
	"context"
	"fmt"
	"sync"

	"fieldsync"
)

type entry struct {
	batch   fieldsync.Batch
	receipt fieldsync.Receipt
}

type lagState struct {
	snapshot  entry
	remaining int
}

// Store is an in-memory fieldsync.Store. The zero value is not ready; use New.
type Store struct {
	// TransformWrite, when non-nil, rewrites a batch before it is persisted.
	// Use it to drop fields or attachments and simulate a partial write.
	TransformWrite func(key string, b fieldsync.Batch) fieldsync.Batch

	// ReadLag is the number of reads after each write that still observe the
	// pre-write snapshot, simulating delayed read-back consistency.
	ReadLag int

	mu      sync.Mutex
	reads   int
	writes  int
	version uint64
	data    map[string]entry
	lag     map[string]lagState
}

// New returns an empty Store.
func New() *Store {
	return &Store{
		data: map[string]entry{},
		lag:  map[string]lagState{},
	}
}

// Reads reports how many Read calls the store has served.
func (s *Store) Reads() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reads
}

// Writes reports how many Write calls the store has served.
func (s *Store) Writes() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writes
}

// Write persists the batch (after TransformWrite, if set) and arms the
// read-lag window with the pre-write snapshot. The batch is cloned before
// TransformWrite runs so injected faults cannot corrupt the caller's
// desired state.
func (s *Store) Write(_ context.Context, key string, b fieldsync.Batch) (fieldsync.Receipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b = cloneBatch(b)
	if s.TransformWrite != nil {
		b = s.TransformWrite(key, b)
	}
	s.version++
	receipt := fieldsync.Receipt{Version: s.version, Token: fmt.Sprintf("tok-%d", s.version)}
	if s.ReadLag > 0 {
		s.lag[key] = lagState{snapshot: s.data[key], remaining: s.ReadLag}
	}
	s.data[key] = entry{batch: cloneBatch(b), receipt: receipt}
	s.writes++
	return receipt, nil
}

// Read returns the current batch, or the pre-write snapshot while the
// read-lag window is open. Missing keys yield an empty batch and zero receipt.
func (s *Store) Read(_ context.Context, key string) (fieldsync.Batch, fieldsync.Receipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reads++
	if ls, ok := s.lag[key]; ok && ls.remaining > 0 {
		ls.remaining--
		s.lag[key] = ls
		return cloneBatch(ls.snapshot.batch), ls.snapshot.receipt, nil
	}
	e := s.data[key]
	return cloneBatch(e.batch), e.receipt, nil
}

func cloneBatch(b fieldsync.Batch) fieldsync.Batch {
	out := fieldsync.Batch{Attachments: append([]fieldsync.Attachment(nil), b.Attachments...)}
	if b.Fields != nil {
		out.Fields = make(map[string]string, len(b.Fields))
		for k, v := range b.Fields {
			out.Fields[k] = v
		}
	}
	return out
}
