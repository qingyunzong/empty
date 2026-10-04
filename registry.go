package kvmerge

import (
	"sort"
	"sync"
)

// Registry 跟踪已注册的快照读者序号；同一序号可被多个读者注册。
type Registry struct {
	mu    sync.Mutex
	count map[uint64]int
}

// NewRegistry 构造空的快照注册表。
func NewRegistry() *Registry { return &Registry{count: make(map[uint64]int)} }

// Register 注册一个停留在 seq 的快照读者。
func (r *Registry) Register(seq uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.count[seq]++
}

// Unregister 注销一个 seq 处的快照读者。
func (r *Registry) Unregister(seq uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.count[seq] > 1 {
		r.count[seq]--
	} else {
		delete(r.count, seq)
	}
}

// Snapshots 返回当前已注册的快照序号（升序、去重）。
func (r *Registry) Snapshots() []uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]uint64, 0, len(r.count))
	for s := range r.count {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
