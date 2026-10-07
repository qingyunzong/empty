package indexrebuild

import "sync"

// Op 是一条已提交的变更日志记录，Version 单调递增。
type Op struct {
	Version uint64
	Key     string
	Value   string
	Delete  bool
}

// MainTable 是源主表：数据 + 版本号 + 提交日志。
// 写路径必须由 Store 的写锁串行化。
type MainTable struct {
	mu      sync.RWMutex
	data    map[string]string
	version uint64
	log     []Op
}

func NewMainTable() *MainTable {
	return &MainTable{data: make(map[string]string)}
}

func (m *MainTable) Put(key, value string) Op {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.version++
	m.data[key] = value
	op := Op{Version: m.version, Key: key, Value: value}
	m.log = append(m.log, op)
	return op
}

func (m *MainTable) Delete(key string) Op {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.version++
	delete(m.data, key)
	op := Op{Version: m.version, Key: key, Delete: true}
	m.log = append(m.log, op)
	return op
}

// Snapshot 冻结源版本：返回一致的 (version, data) 快照。
func (m *MainTable) Snapshot() (uint64, map[string]string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cp := make(map[string]string, len(m.data))
	for k, v := range m.data {
		cp[k] = v
	}
	return m.version, cp
}

// ChangesSince 返回版本号 > v 的全部提交日志（含删除），按提交顺序。
func (m *MainTable) ChangesSince(v uint64) []Op {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var ops []Op
	for _, op := range m.log {
		if op.Version > v {
			ops = append(ops, op)
		}
	}
	return ops
}

// FullScan 返回当前主表全量拷贝，作为重建结果的对照基准。
func (m *MainTable) FullScan() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cp := make(map[string]string, len(m.data))
	for k, v := range m.data {
		cp[k] = v
	}
	return cp
}
