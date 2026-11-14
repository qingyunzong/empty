package dataeng

import (
	"errors"
	"fmt"
	"hash/fnv"
	"reflect"
)

// Value 是被 distinct 追踪的输入值，必须可比较；nil 表示 SQL NULL。
type Value = any

// Update 描述对 (Group, Value) 的一次引用计数增量。
// Delta 为正表示插入，为负表示撤回。
type Update struct {
	Group string
	Value Value
	Delta int64
}

// Change 是聚合输出的 0->1（Delta=+1）或 1->0（Delta=-1）变化。
type Change struct {
	Group string
	Value Value
	Delta int64
}

// ErrUncomparableValue 表示输入值不可比较，无法作为状态键。
var ErrUncomparableValue = errors.New("distinct agg: value is not comparable")

// ConflictError 表示一次更新会使某个 (Group, Value) 的引用计数变为负数。
// 返回该错误时，整个批次不会被部分应用。
type ConflictError struct {
	Group string
	Value Value
	Count int64 // 当前引用计数
	Delta int64 // 批次内净增量
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("distinct agg conflict: group %q value %v: count %d + delta %d < 0",
		e.Group, e.Value, e.Count, e.Delta)
}

type shard struct {
	counts map[string]map[Value]int64
}

// DistinctAgg 按组维护值的引用计数，并在计数跨越 0/1 边界时输出变化。
// NULL（nil）按聚合语义计入引用计数但不进入 distinct 输出。
// 它不是并发安全的，并发场景需由执行器在外部同步。
type DistinctAgg struct {
	shards []shard
}

// New 创建一个按组哈希分片的 DistinctAgg；numShards < 1 时按 1 处理。
func New(numShards int) *DistinctAgg {
	if numShards < 1 {
		numShards = 1
	}
	d := &DistinctAgg{shards: make([]shard, numShards)}
	for i := range d.shards {
		d.shards[i].counts = make(map[string]map[Value]int64)
	}
	return d
}

func (d *DistinctAgg) shardOf(group string) *shard {
	h := fnv.New32a()
	_, _ = h.Write([]byte(group))
	return &d.shards[int(h.Sum32())%len(d.shards)]
}

func (d *DistinctAgg) count(group string, v Value) int64 {
	if vs, ok := d.shardOf(group).counts[group]; ok {
		return vs[v]
	}
	return 0
}

func (d *DistinctAgg) setCount(group string, v Value, c int64) {
	s := d.shardOf(group)
	vs, ok := s.counts[group]
	if c == 0 {
		if ok {
			delete(vs, v)
			if len(vs) == 0 {
				delete(s.counts, group)
			}
		}
		return
	}
	if !ok {
		vs = make(map[Value]int64)
		s.counts[group] = vs
	}
	vs[v] = c
}

// Apply 原子地应用一批更新：先聚合净增量并校验所有计数不为负，
// 任一键冲突则返回 *ConflictError 且状态完全不变；校验通过才写入状态，
// 并按净增量首次出现的顺序输出 0->1 / 1->0 变化。
func (d *DistinctAgg) Apply(updates []Update) ([]Change, error) {
	type key struct {
		group string
		value Value
	}
	nets := make(map[key]int64, len(updates))
	order := make([]key, 0, len(updates))
	for _, u := range updates {
		if u.Delta == 0 {
			continue
		}
		if u.Value != nil && !reflect.TypeOf(u.Value).Comparable() {
			return nil, fmt.Errorf("%w: %T", ErrUncomparableValue, u.Value)
		}
		k := key{u.Group, u.Value}
		if _, ok := nets[k]; !ok {
			order = append(order, k)
		}
		nets[k] += u.Delta
	}
	for _, k := range order {
		cur := d.count(k.group, k.value)
		if cur+nets[k] < 0 {
			return nil, &ConflictError{Group: k.group, Value: k.value, Count: cur, Delta: nets[k]}
		}
	}
	var changes []Change
	for _, k := range order {
		delta := nets[k]
		if delta == 0 {
			continue
		}
		cur := d.count(k.group, k.value)
		next := cur + delta
		d.setCount(k.group, k.value, next)
		if k.value == nil {
			continue // NULL 按聚合语义不进入 distinct 输出
		}
		switch {
		case cur == 0 && next > 0:
			changes = append(changes, Change{Group: k.group, Value: k.value, Delta: +1})
		case cur > 0 && next == 0:
			changes = append(changes, Change{Group: k.group, Value: k.value, Delta: -1})
		}
	}
	return changes, nil
}

// Undo 撤回一批之前已应用的更新，等价于将所有 Delta 取反后 Apply。
func (d *DistinctAgg) Undo(updates []Update) ([]Change, error) {
	inv := make([]Update, len(updates))
	for i, u := range updates {
		inv[i] = u
		inv[i].Delta = -u.Delta
	}
	return d.Apply(inv)
}

// Merge 将 other 各分片的引用计数累加进 d（分片数可不同）。
// 合并是状态重组而非新输入事件，因此不产生输出变化；
// 合并结果与从合并后多重集重算一致。
func (d *DistinctAgg) Merge(other *DistinctAgg) {
	for i := range other.shards {
		for group, values := range other.shards[i].counts {
			for v, c := range values {
				d.setCount(group, v, d.count(group, v)+c)
			}
		}
	}
}

// Snapshot 返回当前状态的深拷贝：group -> value -> 引用计数（仅含计数 > 0 的项）。
func (d *DistinctAgg) Snapshot() map[string]map[Value]int64 {
	out := make(map[string]map[Value]int64)
	for i := range d.shards {
		for group, values := range d.shards[i].counts {
			vs := make(map[Value]int64, len(values))
			for v, c := range values {
				vs[v] = c
			}
			out[group] = vs
		}
	}
	return out
}
