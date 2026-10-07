package indexrebuild

import (
	"sort"
	"sync"
)

// Index 是 value -> keys 的二级索引，forward 用于在更新/删除时
// 找到 key 的旧 value 以便从旧倒排链中摘除。
type Index struct {
	mu      sync.RWMutex
	forward map[string]string
	byValue map[string]map[string]struct{}
}

func NewIndex() *Index {
	return &Index{
		forward: make(map[string]string),
		byValue: make(map[string]map[string]struct{}),
	}
}

// BuildIndex 从冻结快照构建全新索引。
func BuildIndex(data map[string]string) *Index {
	idx := NewIndex()
	for k, v := range data {
		idx.forward[k] = v
		if idx.byValue[v] == nil {
			idx.byValue[v] = make(map[string]struct{})
		}
		idx.byValue[v][k] = struct{}{}
	}
	return idx
}

// Apply 重放一条提交日志（含删除），可作用于构建中的新索引或在线索引。
func (i *Index) Apply(op Op) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if old, ok := i.forward[op.Key]; ok {
		delete(i.byValue[old], op.Key)
		if len(i.byValue[old]) == 0 {
			delete(i.byValue, old)
		}
		delete(i.forward, op.Key)
	}
	if op.Delete {
		return
	}
	i.forward[op.Key] = op.Value
	if i.byValue[op.Value] == nil {
		i.byValue[op.Value] = make(map[string]struct{})
	}
	i.byValue[op.Value][op.Key] = struct{}{}
}

// Get 查询某个 value 对应的所有 key（排序后返回，便于比较）。
func (i *Index) Get(value string) []string {
	i.mu.RLock()
	defer i.mu.RUnlock()
	set := i.byValue[value]
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Equal 与另一个索引做内容对照（测试中与主表全扫描结果比对）。
func (i *Index) Equal(other *Index) bool {
	i.mu.RLock()
	defer i.mu.RUnlock()
	other.mu.RLock()
	defer other.mu.RUnlock()
	if len(i.forward) != len(other.forward) {
		return false
	}
	for k, v := range i.forward {
		if other.forward[k] != v {
			return false
		}
	}
	return true
}
