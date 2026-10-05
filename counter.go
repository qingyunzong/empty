// Package counterlib 处理带位宽的累计计数器读数序列，
// 计算相邻采样之间的增量区间。
//
// 规则：
//   - 读数按位宽取模（仅低 Bits 位有效）；
//   - 显式重置标记（Reset）使前一区间增量未知；
//   - 读数下降时，仅在 AllowWrap 为 true 时按恰好一次回卷补模，
//     否则该区间输出为未知；
//   - 绝不推测多次回卷：补模至多一次；
//   - 同一时刻的重复采样取 Version 最高者（Version 相同取先出现者）。
package counterlib

import "sort"

// Sample 表示一次计数器读数。
type Sample struct {
	Time    int64  // 采样时刻
	Value   uint64 // 累计读数，仅低 Bits 位有效
	Reset   bool   // 显式重置标记：计数器在该时刻前被重置
	Version uint32 // 同一时刻重复读数的版本号
}

// Interval 表示相邻两个有效采样之间的区间结果。
type Interval struct {
	From  int64  // 区间起点时刻
	To    int64  // 区间终点时刻
	Delta uint64 // 区间内计数器增量，仅 Known 为 true 时有效
	Known bool   // false 表示该区间增量未知
}

// Counter 描述计数器的位宽与回卷策略。
type Counter struct {
	Bits uint // 位宽，取值 1..64
	// AllowWrap 为 true 时，无重置标记的读数下降按恰好一次回卷补模；
	// 为 false 时，该区间输出为未知。
	AllowWrap bool
}

// mask 返回低 Bits 位的掩码；Bits >= 64 时为全 1。
func (c Counter) mask() uint64 {
	if c.Bits >= 64 {
		return ^uint64(0)
	}
	return (uint64(1) << c.Bits) - 1
}

// sub 计算 a-b 的模 2^Bits 结果，至多补偿一次回卷。
func (c Counter) sub(a, b uint64) uint64 {
	return (a - b) & c.mask()
}

// Process 对采样序列求区间增量。
// 输入可乱序、可含重复时刻；相同时刻仅保留 Version 最高者。
// 返回按时间升序的区间列表；有效采样不足两个时返回空。
func (c Counter) Process(samples []Sample) []Interval {
	best := make(map[int64]Sample, len(samples))
	for _, s := range samples {
		s.Value &= c.mask()
		if old, ok := best[s.Time]; !ok || s.Version > old.Version {
			best[s.Time] = s
		}
	}
	uniq := make([]Sample, 0, len(best))
	for _, s := range best {
		uniq = append(uniq, s)
	}
	sort.Slice(uniq, func(i, j int) bool { return uniq[i].Time < uniq[j].Time })

	if len(uniq) < 2 {
		return nil
	}
	out := make([]Interval, 0, len(uniq)-1)
	for i := 1; i < len(uniq); i++ {
		prev, cur := uniq[i-1], uniq[i]
		iv := Interval{From: prev.Time, To: cur.Time}
		switch {
		case cur.Reset:
			// 显式重置：增量不可由读数差推得。
		case cur.Value >= prev.Value:
			iv.Delta = c.sub(cur.Value, prev.Value)
			iv.Known = true
		case c.AllowWrap:
			// 下降且允许一次回卷：补模一次，绝不推测多次。
			iv.Delta = c.sub(cur.Value, prev.Value)
			iv.Known = true
		}
		out = append(out, iv)
	}
	return out
}
