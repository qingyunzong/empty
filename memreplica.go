package readroute

import (
	"context"
	"sync"
)

// MemReplica is an in-memory Replica. Apply advances its applied sequence and
// stores a versioned value, simulating a replica catching up with the log.
type MemReplica struct {
	mu       sync.RWMutex
	id       string
	applied  Seq
	values   map[string]VersionedValue
	onChange func()
}

func NewMemReplica(id string) *MemReplica {
	return &MemReplica{id: id, values: make(map[string]VersionedValue)}
}

// SetOnChange registers a hook (e.g. Router.NotifyUpdate) invoked after Apply.
func (m *MemReplica) SetOnChange(fn func()) { m.onChange = fn }

func (m *MemReplica) ID() string { return m.id }

func (m *MemReplica) AppliedSeq() Seq {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.applied
}

// Apply records that entries up to seq are applied and stores value for key
// at that version. seq must not regress.
func (m *MemReplica) Apply(seq Seq, key string, value []byte) {
	m.mu.Lock()
	if seq > m.applied {
		m.applied = seq
	}
	m.values[key] = VersionedValue{Value: value, Seq: seq}
	m.mu.Unlock()
	if m.onChange != nil {
		m.onChange()
	}
}

func (m *MemReplica) Read(_ context.Context, key string) (VersionedValue, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	v, ok := m.values[key]
	if !ok {
		return VersionedValue{}, ErrKeyNotFound
	}
	return v, nil
}
