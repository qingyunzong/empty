// Package windowagg 提供按业务时间（事件时间）做半开窗口聚合的统计库。
//
// 语义约定：
//   - 窗口为半开区间 [start, start+size)，按窗口大小对齐；
//   - 水位（watermark）只增不减，取迄今为止见过的最大事件时间；
//   - 允许迟到至水位减 L：事件时间 t >= watermark-L 被接受，更老的事件被拒绝；
//   - 更正事件引用原事件 ID，先撤销旧贡献再计入新贡献；
//   - 每个窗口维护修订序号，窗口内容每次变动（计入或撤销）序号加一。
package windowagg

import "sort"

// Event 是一条输入事件。Time 为业务时间，与窗口大小同单位。
// 相同 ID 的后到事件视为对先前事件的更正。
type Event struct {
	ID    string
	Time  int64
	Value float64
}

// Window 是一个窗口聚合结果的快照。
type Window struct {
	Start    int64 // 窗口起点（含）
	End      int64 // 窗口终点（不含）
	Count    int   // 当前存活事件数
	Sum      float64
	Revision uint64 // 修订序号，窗口每次变动递增
}

type windowState struct {
	count int
	sum   float64
	rev   uint64
}

// Aggregator 是流式窗口聚合器。它保留全部存活事件与窗口状态，
// 不做状态清理，因此聚合结果始终精确，可与全量重算对照。
type Aggregator struct {
	size      int64
	lateness  int64
	watermark int64
	started   bool
	live      map[string]Event
	windows   map[int64]*windowState
	rejected  int
}

// NewAggregator 创建聚合器。windowSize 必须为正，lateness（即 L）必须非负。
func NewAggregator(windowSize, lateness int64) *Aggregator {
	if windowSize <= 0 {
		panic("windowagg: windowSize must be positive")
	}
	if lateness < 0 {
		panic("windowagg: lateness must be non-negative")
	}
	return &Aggregator{
		size:     windowSize,
		lateness: lateness,
		live:     make(map[string]Event),
		windows:  make(map[int64]*windowState),
	}
}

// windowStart 返回 t 所属半开窗口的起点，对负时间同样成立。
func windowStart(size, t int64) int64 {
	r := t % size
	if r < 0 {
		r += size
	}
	return t - r
}

// Add 摄入一条事件；若 ID 已存在则为更正，先撤销旧贡献再计入新贡献。
// 事件时间早于 watermark-L 时拒绝并返回 false（旧贡献保持不变）。
func (a *Aggregator) Add(e Event) bool {
	if a.started && e.Time < a.watermark-a.lateness {
		a.rejected++
		return false
	}
	if !a.started || e.Time > a.watermark {
		a.watermark = e.Time
		a.started = true
	}
	if old, ok := a.live[e.ID]; ok {
		a.apply(old, -1)
	}
	a.live[e.ID] = e
	a.apply(e, +1)
	return true
}

func (a *Aggregator) apply(e Event, sign float64) {
	start := windowStart(a.size, e.Time)
	w := a.windows[start]
	if w == nil {
		w = &windowState{}
		a.windows[start] = w
	}
	w.count += int(sign)
	w.sum += sign * e.Value
	w.rev++
}

// Watermark 返回当前水位；第二个返回值表示是否已摄入过事件。
func (a *Aggregator) Watermark() (int64, bool) {
	return a.watermark, a.started
}

// Rejected 返回因超出迟到界限而被拒绝的事件数。
func (a *Aggregator) Rejected() int {
	return a.rejected
}

// Live 返回当前全部存活事件（更正后的最终版本），按 ID 排序。
func (a *Aggregator) Live() []Event {
	out := make([]Event, 0, len(a.live))
	for _, e := range a.live {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Windows 返回当前非空窗口的快照，按窗口起点升序。
// 被撤销至空的窗口保留修订历史，但不出现在快照中。
func (a *Aggregator) Windows() []Window {
	out := make([]Window, 0, len(a.windows))
	for start, w := range a.windows {
		if w.count == 0 {
			continue
		}
		out = append(out, Window{
			Start:    start,
			End:      start + a.size,
			Count:    w.count,
			Sum:      w.sum,
			Revision: w.rev,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out
}

// Recompute 对一批存活事件做全量重算，作为流式增量结果的参照实现。
// 它不涉及水位与迟到判定，输入应为先前被接受的存活事件。
func Recompute(windowSize int64, events []Event) []Window {
	if windowSize <= 0 {
		panic("windowagg: windowSize must be positive")
	}
	type acc struct {
		count int
		sum   float64
	}
	m := make(map[int64]*acc)
	for _, e := range events {
		start := windowStart(windowSize, e.Time)
		a := m[start]
		if a == nil {
			a = &acc{}
			m[start] = a
		}
		a.count++
		a.sum += e.Value
	}
	out := make([]Window, 0, len(m))
	for start, a := range m {
		out = append(out, Window{
			Start: start,
			End:   start + windowSize,
			Count: a.count,
			Sum:   a.sum,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out
}
