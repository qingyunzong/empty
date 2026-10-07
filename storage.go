package crashreplay

import "math/rand"

// Write is a single buffered write.
type Write struct {
	Key   string
	Value string
}

// Storage is the implementation under test: writes are buffered until a
// sync; a crash preserves every synced write plus an arbitrary subset of
// the buffered ones.
type Storage struct {
	durable map[string]string
	pending []Write
	rng     *rand.Rand
}

// NewStorage returns a Storage whose crash-recovery choices are
// deterministic for the given seed.
func NewStorage(seed int64) *Storage {
	return &Storage{
		durable: map[string]string{},
		rng:     rand.New(rand.NewSource(seed)),
	}
}

// Durable returns a copy of the synced state.
func (s *Storage) Durable() map[string]string { return clone(s.durable) }

// Pending returns a copy of the buffered writes since the last sync.
func (s *Storage) Pending() []Write { return append([]Write(nil), s.pending...) }

// Write buffers a write.
func (s *Storage) Write(key, value string) {
	s.pending = append(s.pending, Write{Key: key, Value: value})
}

// Sync flushes buffered writes to durable storage.
func (s *Storage) Sync() {
	for _, w := range s.pending {
		s.durable[w.Key] = w.Value
	}
	s.pending = nil
}

// Recover performs the implementation's actual crash recovery: every
// buffered write survives with probability 1/2 (seeded, deterministic per
// Storage instance); surviving writes apply in their original order.
func (s *Storage) Recover() map[string]string {
	recovered := clone(s.durable)
	for _, w := range s.pending {
		if s.rng.Intn(2) == 0 {
			recovered[w.Key] = w.Value
		}
	}
	s.durable = recovered
	s.pending = nil
	return clone(recovered)
}

func clone(m map[string]string) map[string]string {
	c := make(map[string]string, len(m))
	for k, v := range m {
		c[k] = v
	}
	return c
}
