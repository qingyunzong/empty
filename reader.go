package pagestore

import "sync"

// Reader is a snapshot handle pinning one committed version. While a
// Reader is open, every page of its version stays allocated, even if
// newer commits supersede them.
type Reader struct {
	store *Store
	ver   *version
	once  sync.Once
}

// Acquire pins the current root version and returns a reader for it.
func (s *Store) Acquire() *Reader {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.holders[s.root]++
	return &Reader{store: s, ver: s.root}
}

// Get returns the value of key as of the pinned version.
func (r *Reader) Get(key string) ([]byte, bool) {
	r.store.mu.RLock()
	defer r.store.mu.RUnlock()
	id, ok := r.ver.dir[key]
	if !ok {
		return nil, false
	}
	val, ok := r.store.data[id]
	if !ok {
		return nil, false
	}
	return append([]byte(nil), val...), true
}

// Version returns the pinned version number.
func (r *Reader) Version() uint64 {
	return r.ver.num
}

// Close releases the version pin. Pages of the pinned version that no
// other live version references are recycled to the free pool.
func (r *Reader) Close() {
	r.once.Do(func() {
		r.store.mu.Lock()
		defer r.store.mu.Unlock()
		r.store.unhold(r.ver)
	})
}
