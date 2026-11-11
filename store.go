package q150

import (
	"context"
	"sync"
)

// MemoryStore 是进程内的 ResumeStore 实现，并发安全。
//
// 生产环境可替换为数据库、磁盘等持久化实现；空 ID 的 Save 会
// 清除恢复标记，使后续 Load 返回 ok == false。
type MemoryStore struct {
	mu sync.RWMutex
	id string
	ok bool
}

// NewMemoryStore 创建空的内存存储。
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{}
}

// Load 返回最近一次保存的恢复 ID。
func (m *MemoryStore) Load(_ context.Context) (string, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.id, m.ok, nil
}

// Save 持久化恢复 ID；空 ID 清除恢复标记。
func (m *MemoryStore) Save(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.id = id
	m.ok = id != ""
	return nil
}
