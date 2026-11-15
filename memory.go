package dataeng

import (
	"context"
	"sync"
)

// MemoryStore is an in-memory Store implementation, suitable for tests and
// as a reference for transactional backends. All terminal transitions are
// compare-and-swap under a single mutex.
type MemoryStore struct {
	mu        sync.Mutex
	states    map[string]TaskState
	jobByKey  map[string]string
	jobByTask map[string]string
	shards    map[string]map[int]PersistedShard
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		states:    make(map[string]TaskState),
		jobByKey:  make(map[string]string),
		jobByTask: make(map[string]string),
		shards:    make(map[string]map[int]PersistedShard),
	}
}

func (m *MemoryStore) RegisterTask(_ context.Context, taskID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.states[taskID]; !ok {
		m.states[taskID] = TaskActive
	}
	return nil
}

func (m *MemoryStore) LoadJob(_ context.Context, idempotencyKey string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	jobID, ok := m.jobByKey[idempotencyKey]
	return jobID, ok, nil
}

func (m *MemoryStore) SaveJob(_ context.Context, taskID, idempotencyKey, jobID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.jobByKey[idempotencyKey] = jobID
	m.jobByTask[taskID] = jobID
	return nil
}

func (m *MemoryStore) JobFor(_ context.Context, taskID string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	jobID, ok := m.jobByTask[taskID]
	return jobID, ok, nil
}

func (m *MemoryStore) SaveShard(_ context.Context, taskID string, shard PersistedShard) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.shards[taskID] == nil {
		m.shards[taskID] = make(map[int]PersistedShard)
	}
	m.shards[taskID][shard.Index] = shard
	return nil
}

func (m *MemoryStore) State(_ context.Context, taskID string) (TaskState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, ok := m.states[taskID]
	if !ok {
		return "", ErrUnknownTask
	}
	return state, nil
}

func (m *MemoryStore) TryCommit(_ context.Context, taskID string, wantShards int) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, ok := m.states[taskID]
	if !ok {
		return false, ErrUnknownTask
	}
	if state != TaskActive {
		return false, nil
	}
	if len(m.shards[taskID]) != wantShards {
		return false, nil
	}
	m.states[taskID] = TaskSucceeded
	return true, nil
}

func (m *MemoryStore) TryCancel(_ context.Context, taskID string) (bool, error) {
	return m.transition(taskID, TaskCancelled)
}

func (m *MemoryStore) TryFail(_ context.Context, taskID string) (bool, error) {
	return m.transition(taskID, TaskFailed)
}

func (m *MemoryStore) transition(taskID string, to TaskState) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, ok := m.states[taskID]
	if !ok {
		return false, ErrUnknownTask
	}
	if state != TaskActive {
		return false, nil
	}
	m.states[taskID] = to
	return true, nil
}

// ShardCount reports how many shards are persisted for a task (test helper).
func (m *MemoryStore) ShardCount(taskID string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.shards[taskID])
}
