// Package locate 根据多个传感器给出的坐标矩形范围与置信权，
// 计算被至少 k 个范围覆盖的可行区域；若可行区域为空，
// 则给出尺寸最小的冲突子集（公共交集为空的传感器集合）作为冲突证书。
package locate

import "sort"

// Rect 为轴对齐矩形，采用闭区间语义：[MinX,MaxX] x [MinY,MaxY]。
type Rect struct {
	MinX, MinY, MaxX, MaxY float64
}

// Canonical 返回规范化矩形，保证 MinX<=MaxX 且 MinY<=MaxY。
func (r Rect) Canonical() Rect {
	if r.MinX > r.MaxX {
		r.MinX, r.MaxX = r.MaxX, r.MinX
	}
	if r.MinY > r.MaxY {
		r.MinY, r.MaxY = r.MaxY, r.MinY
	}
	return r
}

// Empty 报告矩形是否退化（面积非正）。
func (r Rect) Empty() bool { return r.MaxX <= r.MinX || r.MaxY <= r.MinY }

// ContainsRect 报告 r 是否完整包含 s。
func (r Rect) ContainsRect(s Rect) bool {
	return r.MinX <= s.MinX && s.MaxX <= r.MaxX && r.MinY <= s.MinY && s.MaxY <= r.MaxY
}

// ContainsPoint 报告点 (x,y) 是否落在 r 内（闭区间）。
func (r Rect) ContainsPoint(x, y float64) bool {
	return r.MinX <= x && x <= r.MaxX && r.MinY <= y && y <= r.MaxY
}

// Intersect 返回两矩形的交集；第二个返回值报告交集是否非退化。
func (r Rect) Intersect(s Rect) (Rect, bool) {
	t := Rect{
		MinX: max(r.MinX, s.MinX),
		MinY: max(r.MinY, s.MinY),
		MaxX: min(r.MaxX, s.MaxX),
		MaxY: min(r.MaxY, s.MaxY),
	}
	return t, !t.Empty()
}

// Area 返回矩形面积，退化矩形面积为 0。
func (r Rect) Area() float64 {
	if r.Empty() {
		return 0
	}
	return (r.MaxX - r.MinX) * (r.MaxY - r.MinY)
}

// Sensor 为一个定位传感器给出的范围估计。
type Sensor struct {
	ID     string  // 传感器标识
	Rect   Rect    // 目标可能所在的坐标矩形范围
	Weight float64 // 置信权
}

// RegionRect 为可行区域分解出的一块规范矩形，附带来源信息。
type RegionRect struct {
	Rect    Rect     // 规范化的区域矩形
	Sources []string // 完整覆盖该矩形的传感器 ID（按字典序）
	Weight  float64  // 来源传感器置信权之和
}

// IntersectAll 返回所有矩形的公共交集；ok 为 false 表示交集退化（为空）。
func IntersectAll(rects []Rect) (Rect, bool) {
	if len(rects) == 0 {
		return Rect{}, false
	}
	acc := rects[0].Canonical()
	for _, r := range rects[1:] {
		var ok bool
		acc, ok = acc.Intersect(r.Canonical())
		if !ok {
			return acc, false
		}
	}
	return acc, true
}

// sortedUnique 返回升序去重副本。
func sortedUnique(v []float64) []float64 {
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	out := s[:0]
	for i, x := range s {
		if i == 0 || x != s[i-1] {
			out = append(out, x)
		}
	}
	return out
}
