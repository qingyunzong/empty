// Package seqquery 在连续事件序列中查询满足约束的最优连续事件段。
//
// 约束：
//   - 时间跨度（末事件时间 - 首事件时间）不超过 T；
//   - 段内至少覆盖 k 个不同类型；
//   - 来源互斥：段内任意两事件的 Source 不同；
//   - 累计库存不为负：段内按顺序累加 Inv，任意前缀和 >= 0。
//
// 目标为收益（Value 之和，可为负）最大；空段恒为合法候选，收益 0。
// 并列时依次按：段更短、开始更早、段内 ID 序列字典序更小。
// 输入可乱序，库内按 (Time, ID) 排序。事件总数至多 30。
package seqquery

import "slices"

// MaxEvents 为库支持的最大事件数。
const MaxEvents = 30

// Event 描述一个事件。
type Event struct {
	ID     int    // 事件标识，用于排序与并列判定
	Time   int64  // 事件发生时间
	Value  int64  // 收益（可为负）
	Type   string // 类型，用于覆盖约束
	Source string // 来源，段内互斥
	Inv    int64  // 库存增量（可为负）
}

// Query 描述一次查询的约束参数。
type Query struct {
	MaxSpan  int64 // T：段时间跨度上限
	MinTypes int   // k：至少覆盖的类型数
}

// Result 为查询结果，附带逐前缀库存与覆盖证书。
type Result struct {
	Version   int              // 生成该结果的数据版本
	Events    []Event          // 选中的连续段（已按 (Time, ID) 排序），空切片表示空段
	Profit    int64            // 段收益
	PrefixInv []int64          // 逐前缀库存：PrefixInv[i] 为段内前 i+1 个事件的 Inv 之和
	Coverage  map[string][]int // 覆盖证书：类型 -> 段内该类型事件的 ID 列表
}

// Empty 报告结果是否为空段。
func (r Result) Empty() bool { return len(r.Events) == 0 }

// Library 保存事件数据并应答查询。更正数据会使旧结果失效。
type Library struct {
	events  []Event // 已按 (Time, ID) 排序
	version int
}

// New 返回空库。
func New() *Library { return &Library{} }

// Set 以给定事件替换库中数据（允许乱序输入），版本号递增。
func (l *Library) Set(events []Event) {
	if len(events) > MaxEvents {
		panic("seqquery: too many events")
	}
	l.events = sortEvents(events)
	l.version++
}

// Correct 用更正后的事件集替换数据，此前产出的所有 Result 随即失效。
func (l *Library) Correct(events []Event) { l.Set(events) }

// Version 返回当前数据版本号。
func (l *Library) Version() int { return l.version }

// Valid 报告结果 r 是否仍对当前数据有效（未被更正撤销）。
func (l *Library) Valid(r Result) bool { return r.Version == l.version }

// Events 返回库中已排序的事件副本。
func (l *Library) Events() []Event { return slices.Clone(l.events) }

// Query 在当前数据上求解最优段。
func (l *Library) Query(q Query) Result {
	return buildResult(l.events, solve(l.events, q), l.version)
}

// sortEvents 返回按 (Time, ID) 排序的副本。
func sortEvents(events []Event) []Event {
	out := slices.Clone(events)
	slices.SortFunc(out, func(a, b Event) int {
		if a.Time != b.Time {
			return compareInt64(a.Time, b.Time)
		}
		return compareInt(a.ID, b.ID)
	})
	return out
}

// candidate 表示排序后事件上的一个半开区间 [start, end)。
type candidate struct {
	start, end int
	profit     int64
}

// better 报告候选 a 是否严格优于候选 b。
// 依次比较：收益降序、段长升序、开始时间升序、ID 序列字典序升序。
func better(events []Event, a, b candidate) bool {
	if a.profit != b.profit {
		return a.profit > b.profit
	}
	lenA, lenB := a.end-a.start, b.end-b.start
	if lenA != lenB {
		return lenA < lenB
	}
	if lenA == 0 {
		return false // 两个空段等价
	}
	if ta, tb := events[a.start].Time, events[b.start].Time; ta != tb {
		return ta < tb
	}
	for x, y := a.start, b.start; x < a.end; x, y = x+1, y+1 {
		if events[x].ID != events[y].ID {
			return events[x].ID < events[y].ID
		}
	}
	return false
}

// solve 增量枚举所有区间，返回最优候选。events 必须已排序。
func solve(events []Event, q Query) candidate {
	best := candidate{} // 空段，收益 0
	n := len(events)
	for i := 0; i < n; i++ {
		var profit, inv int64
		types := make(map[string]struct{})
		sources := make(map[string]struct{})
		for j := i; j < n; j++ {
			e := events[j]
			if e.Time-events[i].Time > q.MaxSpan {
				break // 时间有序，跨度只会继续增大
			}
			if _, dup := sources[e.Source]; dup {
				break // 来源冲突不可由扩展修复
			}
			sources[e.Source] = struct{}{}
			inv += e.Inv
			if inv < 0 {
				break // 已出现负前缀库存，扩展无法修复
			}
			types[e.Type] = struct{}{}
			profit += e.Value
			if len(types) >= q.MinTypes {
				cand := candidate{i, j + 1, profit}
				if better(events, cand, best) {
					best = cand
				}
			}
		}
	}
	return best
}

// buildResult 由候选区间构造带证书的结果。
func buildResult(events []Event, c candidate, version int) Result {
	seg := slices.Clone(events[c.start:c.end])
	prefix := make([]int64, len(seg))
	coverage := make(map[string][]int)
	var inv, profit int64
	for i, e := range seg {
		inv += e.Inv
		prefix[i] = inv
		profit += e.Value
		coverage[e.Type] = append(coverage[e.Type], e.ID)
	}
	return Result{
		Version:   version,
		Events:    seg,
		Profit:    profit,
		PrefixInv: prefix,
		Coverage:  coverage,
	}
}

func compareInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

func compareInt64(a, b int64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}
