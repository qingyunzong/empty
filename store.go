package formal

import (
	"sync"
)

// FencingStore is a Sink implementing storage-side fencing. It remembers the
// highest epoch ever accepted per object and rejects every lower or repeated
// epoch, so even a holder that races a write after losing its lease cannot
// overwrite newer data and no epoch can be persisted twice.
type FencingStore struct {
	mu     sync.Mutex
	high   map[string]uint64
	data   map[string][]byte
	counts map[string]int
	accept int // total accepted WriteBack calls across all objects
}

// NewFencingStore creates an empty fencing store.
func NewFencingStore() *FencingStore {
	return &FencingStore{
		high:   make(map[string]uint64),
		data:   make(map[string][]byte),
		counts: make(map[string]int),
	}
}

// WriteBack accepts only a strictly greater epoch than the one previously
// accepted for object.
func (s *FencingStore) WriteBack(object string, epoch uint64, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if prev, ok := s.high[object]; ok && epoch <= prev {
		return ErrStaleToken
	}
	buf := make([]byte, len(data))
	copy(buf, data)
	s.high[object] = epoch
	s.data[object] = buf
	s.counts[object]++
	s.accept++
	return nil
}

// Accepted returns the number of WriteBack calls the store has accepted.
// Because fencing is strictly monotonic, this is exactly the number of times
// durable data changed and can never count the same epoch twice.
func (s *FencingStore) Accepted() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.accept
}

// AcceptedFor reports the accepted write-back count for one object.
func (s *FencingStore) AcceptedFor(object string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.counts[object]
}

// LastEpoch returns the highest accepted epoch for object and whether any
// write was accepted.
func (s *FencingStore) LastEpoch(object string) (uint64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	epoch, ok := s.high[object]
	return epoch, ok
}

// Load returns the most recently persisted data for object.
func (s *FencingStore) Load(object string) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, ok := s.data[object]
	if !ok {
		return nil, false
	}
	out := make([]byte, len(data))
	copy(out, data)
	return out, true
}
