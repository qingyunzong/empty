package q147

import "sync"

// MemLogStore is an in-memory LogStore. It is useful for tests and as a
// reference implementation; production deployments should inject a durable
// store. Reusing one MemLogStore across several Service instances
// simulates a process restart over a persistent log.
type MemLogStore struct {
	mu      sync.Mutex
	records []Record
}

// NewMemLogStore returns an empty in-memory log store.
func NewMemLogStore() *MemLogStore {
	return &MemLogStore{}
}

// Append implements LogStore.
func (m *MemLogStore) Append(rec Record) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.records = append(m.records, cloneRecord(rec))
	return nil
}

// Replay implements LogStore.
func (m *MemLogStore) Replay(fn func(rec Record) error) error {
	m.mu.Lock()
	records := make([]Record, len(m.records))
	copy(records, m.records)
	m.mu.Unlock()
	for _, rec := range records {
		if err := fn(rec); err != nil {
			return err
		}
	}
	return nil
}

// Records returns a copy of all appended records, oldest first.
func (m *MemLogStore) Records() []Record {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Record, len(m.records))
	copy(out, m.records)
	return out
}

func cloneRecord(rec Record) Record {
	out := rec
	if rec.Data != nil {
		out.Data = append([]byte(nil), rec.Data...)
	}
	if rec.Shards != nil {
		out.Shards = cloneShards(rec.Shards)
	}
	return out
}
