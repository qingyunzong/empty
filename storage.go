package leasesim

// Write records one accepted write in the Store.
type Write struct {
	Holder string
	Fence  uint64
	Key    string
	Value  string
	Time   int64
}

// Store is a fenced key-value store. A write is legal only when the caller
// presents the fence of the lease that is currently valid at the write time
// and that fence is greater than every fence the store has ever accepted.
// A previous holder that never observed its invalidation still cannot write:
// its fence is stale.
type Store struct {
	mgr      *Manager
	maxFence uint64
	data     map[string]string
	accepted []Write
}

// NewStore returns a Store guarded by mgr.
func NewStore(mgr *Manager) *Store {
	return &Store{mgr: mgr, data: make(map[string]string)}
}

// Write attempts a fenced write of key/value at time t.
func (s *Store) Write(holder string, fence uint64, key, value string, t int64) error {
	lease, ok := s.mgr.Current()
	if !ok || lease.Holder != holder || !lease.Valid(t) {
		return ErrNotHolder
	}
	if lease.Fence != fence {
		return ErrFenceMismatch
	}
	if fence <= s.maxFence {
		return ErrStaleFence
	}
	s.maxFence = fence
	s.data[key] = value
	s.accepted = append(s.accepted, Write{Holder: holder, Fence: fence, Key: key, Value: value, Time: t})
	return nil
}

// Get returns the stored value for key.
func (s *Store) Get(key string) (string, bool) {
	v, ok := s.data[key]
	return v, ok
}

// MaxFence returns the highest fence the store has accepted.
func (s *Store) MaxFence() uint64 {
	return s.maxFence
}

// Accepted returns all accepted writes in order.
func (s *Store) Accepted() []Write {
	out := make([]Write, len(s.accepted))
	copy(out, s.accepted)
	return out
}
