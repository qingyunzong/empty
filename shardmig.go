// Package shardmig 实现键区间在分片之间的迁移。
//
// 核心语义：
//   - 键区间为半开区间 [Start, End)，边界键归右区间；
//   - 迁移期间旧分片把落在迁移区间的消息转发给新分片；
//   - 只有新世代（generation）可以在新分片上提交，旧世代提交被拒绝；
//   - 已处理消息 ID 随区间一并迁移，保证重复消息不产生第二次业务效果；
//   - 单次验收（accept）要么完整提交业务效果与已处理 ID，要么完整不提交，
//     中断后重试仍然只产生一次业务效果、状态保持完整。
package shardmig

import (
	"errors"
	"fmt"
	"sync"
)

var (
	// ErrStaleGeneration 表示提交携带的世代已过期。
	ErrStaleGeneration = errors.New("shardmig: stale generation")
	// ErrNoRoute 表示没有任何分片拥有该键。
	ErrNoRoute = errors.New("shardmig: no route for key")
	// ErrNotOwner 表示目标分片不拥有该键且没有转发规则。
	ErrNotOwner = errors.New("shardmig: shard does not own key")
	// ErrUnknownShard 表示分片不存在。
	ErrUnknownShard = errors.New("shardmig: unknown shard")
)

// Range 是半开键区间 [Start, End)。
// 边界键归右区间：等于 End 的键属于下一个区间，不属于本区间。
// 空 Start 表示负无穷，空 End 表示正无穷。
type Range struct {
	Start string
	End   string
}

// Contains 报告 key 是否落在区间内。
func (r Range) Contains(key string) bool {
	if r.Start != "" && key < r.Start {
		return false
	}
	if r.End != "" && key >= r.End {
		return false
	}
	return true
}

func (r Range) valid() bool {
	return r.End == "" || r.Start < r.End
}

func overlaps(a, b Range) bool {
	// a.Start < b.End && b.Start < a.End，注意空界的无穷语义。
	if b.End != "" && a.Start != "" && a.Start >= b.End {
		return false
	}
	if a.End != "" && b.Start != "" && b.Start >= a.End {
		return false
	}
	return true
}

// startLE 比较两个区间下界，空串视为负无穷。
func startLE(a, b string) bool {
	if a == "" {
		return true
	}
	if b == "" {
		return false
	}
	return a <= b
}

// endGE 比较两个区间上界，空串视为正无穷。
func endGE(a, b string) bool {
	if a == "" {
		return true
	}
	if b == "" {
		return false
	}
	return a >= b
}

// Effect 是消息的业务效果：对分片已提交 KV 状态的原子修改。
// 它在暂存副本上执行，只有提交成功才生效。
type Effect func(kv map[string]string) error

// Message 是一条离散消息。ID 用于去重，Key 用于路由。
type Message struct {
	ID    string
	Key   string
	Apply Effect
}

// redirect 是迁移后留在旧分片上的转发规则。
type redirect struct {
	rng    Range
	target *Shard
}

// Shard 保存一个分片的已提交状态。
type Shard struct {
	id      string
	cluster *Cluster

	mu        sync.Mutex
	gen       uint64
	data      map[string]string
	processed map[string]string // 已处理消息 ID -> 消息键（用于随区间迁移）
	owned     []Range           // 当前拥有的区间
	importing []Range           // 迁移中、Commit 前即可接收新世代提交的区间
	moved     []redirect        // 已迁出区间的转发规则
}

// ID 返回分片标识。
func (s *Shard) ID() string { return s.id }

// Generation 返回分片当前世代。
func (s *Shard) Generation() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gen
}

// Get 读取已提交状态中的键。
func (s *Shard) Get(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.data[key]
	return v, ok
}

// Processed 报告消息 ID 是否已在本分片处理过。
func (s *Shard) Processed(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.processed[id]
	return ok
}

// Data 返回已提交状态的副本（用于校验与测试）。
func (s *Shard) Data() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string, len(s.data))
	for k, v := range s.data {
		out[k] = v
	}
	return out
}

// ownsLocked 报告分片当前是否可以提交 key（调用方须持有 s.mu）。
// 迁移目标在 Commit 前即可对迁入区间提交（只认新世代）。
func (s *Shard) ownsLocked(key string) bool {
	for _, r := range s.owned {
		if r.Contains(key) {
			return true
		}
	}
	for _, r := range s.importing {
		if r.Contains(key) {
			return true
		}
	}
	return false
}

// redirectLocked 返回 key 命中的转发规则（调用方须持有 s.mu）。
func (s *Shard) redirectLocked(key string) (redirect, bool) {
	for _, rd := range s.moved {
		if rd.rng.Contains(key) {
			return rd, true
		}
	}
	return redirect{}, false
}

const maxForwardDepth = 8

// accept 在本分片上验收消息。若键已迁出则转发；只有世代匹配才允许提交。
// 业务效果与已处理 ID 在同一个临界区内原子提交：中断则两者都不落盘。
func (s *Shard) accept(msg Message, gen uint64, depth int) error {
	if depth > maxForwardDepth {
		return errors.New("shardmig: forwarding loop detected")
	}
	s.mu.Lock()
	if rd, ok := s.redirectLocked(msg.Key); ok {
		target := rd.target
		s.mu.Unlock()
		// 旧分片转发：以新分片的当前（新）世代提交。
		target.mu.Lock()
		newGen := target.gen
		target.mu.Unlock()
		return target.accept(msg, newGen, depth+1)
	}
	if !s.ownsLocked(msg.Key) {
		s.mu.Unlock()
		return ErrNotOwner
	}
	if gen != s.gen {
		s.mu.Unlock()
		return ErrStaleGeneration
	}
	if _, dup := s.processed[msg.ID]; dup {
		s.mu.Unlock()
		return nil // 重复消息：不再产生业务效果
	}
	// 在暂存副本上执行业务效果，保证中断时不留下部分状态。
	staged := make(map[string]string, len(s.data)+1)
	for k, v := range s.data {
		staged[k] = v
	}
	if err := msg.Apply(staged); err != nil {
		s.mu.Unlock()
		return err
	}
	if hook := s.cluster.interruptHook; hook != nil {
		if err := hook("before-commit"); err != nil {
			s.mu.Unlock()
			return err // 中断：业务效果与已处理 ID 都未提交
		}
	}
	s.data = staged
	s.processed[msg.ID] = msg.Key
	s.mu.Unlock()
	return nil
}

// routeEntry 是路由表项：区间 -> 拥有分片。
type routeEntry struct {
	rng   Range
	shard *Shard
}

// Cluster 管理分片集合与全局路由表。
type Cluster struct {
	mu     sync.Mutex
	shards map[string]*Shard
	routes []routeEntry

	// interruptHook 是测试钩子：在提交前注入中断，返回非 nil 错误则
	// 本次验收整体中止（业务效果与已处理 ID 都不提交）。
	interruptHook func(stage string) error
}

// NewCluster 创建空集群。
func NewCluster() *Cluster {
	return &Cluster{shards: make(map[string]*Shard)}
}

// SetInterruptHook 设置提交前中断钩子（仅用于测试中断验收）。
func (c *Cluster) SetInterruptHook(hook func(stage string) error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.interruptHook = hook
}

// AddShard 添加分片并登记其初始拥有区间。区间不得与已有路由重叠。
func (c *Cluster) AddShard(id string, ranges ...Range) (*Shard, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.shards[id]; ok {
		return nil, fmt.Errorf("shardmig: shard %q already exists", id)
	}
	for _, r := range ranges {
		if !r.valid() {
			return nil, fmt.Errorf("shardmig: invalid range %+v", r)
		}
		for _, e := range c.routes {
			if overlaps(e.rng, r) {
				return nil, fmt.Errorf("shardmig: range %+v overlaps existing route %+v", r, e.rng)
			}
		}
	}
	s := &Shard{
		id:        id,
		cluster:   c,
		data:      make(map[string]string),
		processed: make(map[string]string),
		owned:     append([]Range(nil), ranges...),
	}
	c.shards[id] = s
	for _, r := range ranges {
		c.routes = append(c.routes, routeEntry{rng: r, shard: s})
	}
	return s, nil
}

// Route 返回 key 当前路由到的分片及其世代。
func (c *Cluster) Route(key string) (shardID string, gen uint64, err error) {
	c.mu.Lock()
	var s *Shard
	for _, e := range c.routes {
		if e.rng.Contains(key) {
			s = e.shard
			break
		}
	}
	c.mu.Unlock()
	if s == nil {
		return "", 0, ErrNoRoute
	}
	s.mu.Lock()
	gen = s.gen
	s.mu.Unlock()
	return s.id, gen, nil
}

// Accept 在指定分片上以给定世代验收消息。
// 若该键已迁出，旧分片会转发到新分片并以新世代提交；
// 若世代过期，返回 ErrStaleGeneration。
func (c *Cluster) Accept(shardID string, gen uint64, msg Message) error {
	c.mu.Lock()
	s := c.shards[shardID]
	c.mu.Unlock()
	if s == nil {
		return fmt.Errorf("%w: %q", ErrUnknownShard, shardID)
	}
	return s.accept(msg, gen, 0)
}

// rangeOwnedByLocked 报告 rng 是否完整由 s 拥有（调用方须持有 c.mu）。
// 路由表是不重叠且连续的，沿 rng 逐段检查即可。
func (c *Cluster) rangeOwnedByLocked(rng Range, s *Shard) bool {
	cur := rng.Start
	for {
		var e *routeEntry
		for i := range c.routes {
			if c.routes[i].rng.Contains(cur) {
				e = &c.routes[i]
				break
			}
		}
		if e == nil || e.shard != s {
			return false
		}
		if endGE(e.rng.End, rng.End) {
			return true
		}
		cur = e.rng.End
	}
}

// Migration 表示一次进行中的区间迁移。
type Migration struct {
	cluster *Cluster
	from    *Shard
	to      *Shard
	rng     Range
	done    bool
}

// BeginMigration 开始把 rng 从 fromID 迁移到 toID。
//
// Begin 阶段（在两个分片的锁内原子完成）：
//  1. 新分片世代 +1 —— 此后只有新世代可以在新分片提交；
//  2. 区间内的 KV 状态与已处理消息 ID 一并迁入新分片；
//  3. 旧分片安装转发规则 —— 迁移期间落到旧分片的消息被转发到新分片。
//
// 路由表在 Commit 时才切换，因此 Begin 与 Commit 之间即“迁移期间”。
func (c *Cluster) BeginMigration(fromID, toID string, rng Range) (*Migration, error) {
	if !rng.valid() {
		return nil, fmt.Errorf("shardmig: invalid range %+v", rng)
	}
	c.mu.Lock()
	from, to := c.shards[fromID], c.shards[toID]
	owned := from != nil && c.rangeOwnedByLocked(rng, from)
	c.mu.Unlock()
	if from == nil {
		return nil, fmt.Errorf("%w: %q", ErrUnknownShard, fromID)
	}
	if to == nil {
		return nil, fmt.Errorf("%w: %q", ErrUnknownShard, toID)
	}
	if !owned {
		return nil, fmt.Errorf("shardmig: shard %q does not fully own range %+v", fromID, rng)
	}

	// 按 ID 顺序加锁避免死锁。
	first, second := from, to
	if to.id < from.id {
		first, second = to, from
	}
	first.mu.Lock()
	defer first.mu.Unlock()
	second.mu.Lock()
	defer second.mu.Unlock()

	to.gen++ // 新世代：只有它能提交

	for k, v := range from.data {
		if rng.Contains(k) {
			to.data[k] = v
			delete(from.data, k)
		}
	}
	for id, key := range from.processed {
		if rng.Contains(key) {
			to.processed[id] = key
			delete(from.processed, id)
		}
	}
	from.moved = append(from.moved, redirect{rng: rng, target: to})
	to.importing = append(to.importing, rng)

	return &Migration{cluster: c, from: from, to: to, rng: rng}, nil
}

// Commit 提交迁移：切换路由表与区间归属。
// 之后新消息直接路由到新分片；旧分片上的转发规则保留，
// 用于转发仍拿着旧路由的迟到请求。
func (m *Migration) Commit() error {
	if m.done {
		return errors.New("shardmig: migration already committed")
	}
	c := m.cluster
	c.mu.Lock()
	defer c.mu.Unlock()

	var routes []routeEntry
	for _, e := range c.routes {
		if !overlaps(e.rng, m.rng) {
			routes = append(routes, e)
			continue
		}
		// 左残余 [e.Start, m.rng.Start)
		if startLE(e.rng.Start, m.rng.Start) && e.rng.Start != m.rng.Start {
			routes = append(routes, routeEntry{rng: Range{Start: e.rng.Start, End: m.rng.Start}, shard: e.shard})
		}
		// 右残余 [m.rng.End, e.End)
		if m.rng.End != "" && endGE(e.rng.End, m.rng.End) && e.rng.End != m.rng.End {
			routes = append(routes, routeEntry{rng: Range{Start: m.rng.End, End: e.rng.End}, shard: e.shard})
		}
	}
	routes = append(routes, routeEntry{rng: m.rng, shard: m.to})
	c.routes = routes

	first, second := m.from, m.to
	if m.to.id < m.from.id {
		first, second = m.to, m.from
	}
	first.mu.Lock()
	defer first.mu.Unlock()
	second.mu.Lock()
	defer second.mu.Unlock()

	m.from.owned = subtractRange(m.from.owned, m.rng)
	m.to.importing = subtractRange(m.to.importing, m.rng)
	m.to.owned = append(m.to.owned, m.rng)
	m.done = true
	return nil
}

// subtractRange 从区间列表中移除 rng。
func subtractRange(ranges []Range, rng Range) []Range {
	var out []Range
	for _, r := range ranges {
		if !overlaps(r, rng) {
			out = append(out, r)
			continue
		}
		if startLE(r.Start, rng.Start) && r.Start != rng.Start {
			out = append(out, Range{Start: r.Start, End: rng.Start})
		}
		if rng.End != "" && endGE(r.End, rng.End) && r.End != rng.End {
			out = append(out, Range{Start: rng.End, End: r.End})
		}
	}
	return out
}
