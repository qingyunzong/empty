package formal

type storeSnapshot struct {
	high   map[string]uint64
	data   map[string][]byte
	counts map[string]int
	accept int
}

func (s *FencingStore) dump() storeSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	snap := storeSnapshot{
		high:   make(map[string]uint64, len(s.high)),
		data:   make(map[string][]byte, len(s.data)),
		counts: make(map[string]int, len(s.counts)),
		accept: s.accept,
	}
	for k, v := range s.high {
		snap.high[k] = v
	}
	for k, v := range s.data {
		snap.data[k] = append([]byte(nil), v...)
	}
	for k, v := range s.counts {
		snap.counts[k] = v
	}
	return snap
}

func (s *FencingStore) restore(snap storeSnapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.high = make(map[string]uint64, len(snap.high))
	s.data = make(map[string][]byte, len(snap.data))
	s.counts = make(map[string]int, len(snap.counts))
	for k, v := range snap.high {
		s.high[k] = v
	}
	for k, v := range snap.data {
		s.data[k] = append([]byte(nil), v...)
	}
	for k, v := range snap.counts {
		s.counts[k] = v
	}
	s.accept = snap.accept
}
