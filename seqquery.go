// Package seqquery 在事件序列上查询满足约束的最优连续事件段。
//
// 规则概述：
//   - 输入事件允许乱序，查询前统一按 (Time, ID) 升序排序。
//   - 段收益 = -Σ费用（费用可为负，负费用即收益）；空段收益为 0，且空段永远可行，
//     当没有任何正收益的可行非空段时返回空段。
//   - 可行段约束：时间跨度 <= T；至少覆盖 k 个不同类型；段内来源互斥（不重复）；
//     从初始库存出发的逐事件累计库存不为负；段内事件数 <= 30。
//   - 并列时依次比较：段短（事件数少）优先、开始时间早优先、ID 序列字典序小优先。
//   - 更正（Correct）后旧查询结果作废，Result.Revoked 返回 true。
package seqquery

import "sort"

// MaxSegmentEvents 是单段允许的最大事件数。
const MaxSegmentEvents = 30

// Event 是序列中的一条事件记录。
type Event struct {
	ID     int64
	Time   int64
	Type   string
	Source string
	Cost   int64 // 费用，可为负（负费用即收益）
	Stock  int64 // 该事件引起的库存变化，可为负
}

// Query 描述一次最优段查询。
type Query struct {
	MaxSpan   int64 // 时间跨度上限 T：末事件时间 - 首事件时间 <= MaxSpan
	MinTypes  int   // 段内至少覆盖的不同类型数 k
	InitStock int64 // 段起始时的初始库存
	MaxEvents int   // 段内事件数上限；<=0 或 >30 时按 30 处理
}

func (q Query) eventLimit() int {
	if q.MaxEvents <= 0 || q.MaxEvents > MaxSegmentEvents {
		return MaxSegmentEvents
	}
	return q.MaxEvents
}

// Result 是一次查询的结果，同时充当可行性与覆盖的证书。
type Result struct {
	Events      []Event        // 选中的段，已按 (Time, ID) 排序；空段为 nil
	Profit      int64          // 段收益 = -Σ费用；空段为 0
	PrefixStock []int64        // 逐前缀库存：段内第 i 个事件后的累计库存（含初始库存）
	Coverage    map[string]int // 覆盖证书：类型 -> 段内出现次数

	lib     *Library
	version int64
}

// Empty 报告结果是否为空段。
func (r *Result) Empty() bool { return len(r.Events) == 0 }

// Span 返回段的时间跨度；空段返回 0。
func (r *Result) Span() int64 {
	if len(r.Events) == 0 {
		return 0
	}
	return r.Events[len(r.Events)-1].Time - r.Events[0].Time
}

// Types 返回段覆盖的不同类型，按字典序排列，与 Coverage 一起构成覆盖证书。
func (r *Result) Types() []string {
	types := make([]string, 0, len(r.Coverage))
	for t := range r.Coverage {
		types = append(types, t)
	}
	sort.Strings(types)
	return types
}

// Revoked 报告结果是否已被后续更正作废。
func (r *Result) Revoked() bool {
	return r.lib != nil && r.lib.version != r.version
}

// Library 是事件序列查询库，支持更正并作废旧结果。
type Library struct {
	events  map[int64]Event
	version int64
}

// New 返回空的查询库。
func New() *Library {
	return &Library{events: make(map[int64]Event)}
}

// Add 录入一条事件；同 ID 事件会被覆盖。录入后旧查询结果作废。
func (l *Library) Add(e Event) {
	l.events[e.ID] = e
	l.version++
}

// Correct 更正一条事件（按 ID 替换，不存在则插入）。更正后旧查询结果作废。
func (l *Library) Correct(e Event) {
	l.events[e.ID] = e
	l.version++
}

// Len 返回库中事件数。
func (l *Library) Len() int { return len(l.events) }

// sorted 返回按 (Time, ID) 升序排序的事件副本。
func (l *Library) sorted() []Event {
	evs := make([]Event, 0, len(l.events))
	for _, e := range l.events {
		evs = append(evs, e)
	}
	sort.Slice(evs, func(i, j int) bool {
		if evs[i].Time != evs[j].Time {
			return evs[i].Time < evs[j].Time
		}
		return evs[i].ID < evs[j].ID
	})
	return evs
}

// better 报告候选 a 是否严格优于候选 b：收益高、段短、开始早、ID 序小。
func better(a, b *Result) bool {
	if a.Profit != b.Profit {
		return a.Profit > b.Profit
	}
	if len(a.Events) != len(b.Events) {
		return len(a.Events) < len(b.Events)
	}
	if len(a.Events) > 0 {
		if a.Events[0].Time != b.Events[0].Time {
			return a.Events[0].Time < b.Events[0].Time
		}
	}
	for i := range a.Events {
		if a.Events[i].ID != b.Events[i].ID {
			return a.Events[i].ID < b.Events[i].ID
		}
	}
	return false
}

// buildResult 由已排序段构造结果及证书。
func (l *Library) buildResult(seg []Event, initStock int64) *Result {
	r := &Result{lib: l, version: l.version, Coverage: make(map[string]int)}
	if len(seg) == 0 {
		return r
	}
	r.Events = append([]Event(nil), seg...)
	stock := initStock
	var cost int64
	for _, e := range seg {
		stock += e.Stock
		r.PrefixStock = append(r.PrefixStock, stock)
		r.Coverage[e.Type]++
		cost += e.Cost
	}
	r.Profit = -cost
	return r
}

// Best 查询满足约束的最优连续事件段。段长上限为 30，直接全区间枚举。
func (l *Library) Best(q Query) *Result {
	evs := l.sorted()
	limit := q.eventLimit()
	best := l.buildResult(nil, q.InitStock) // 空段：收益 0，永远可行

	for i := 0; i < len(evs); i++ {
		var costSum int64
		stock := q.InitStock
		types := make(map[string]int)
		sources := make(map[string]struct{})
		for j := i; j < len(evs); j++ {
			e := evs[j]
			if e.Time-evs[i].Time > q.MaxSpan {
				break // 时间有序，跨度只会继续增大
			}
			if j-i+1 > limit {
				break
			}
			if _, dup := sources[e.Source]; dup {
				break // 来源互斥被破坏后扩展无意义
			}
			stock += e.Stock
			if stock < 0 {
				break // 累计库存为负后扩展无意义
			}
			sources[e.Source] = struct{}{}
			types[e.Type]++
			costSum += e.Cost
			if len(types) < q.MinTypes {
				continue // 类型覆盖不足，继续扩展
			}
			cand := l.buildResult(evs[i:j+1], q.InitStock)
			if better(cand, best) {
				best = cand
			}
		}
	}
	return best
}
