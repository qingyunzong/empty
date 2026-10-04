package locate

import (
	"math/bits"
	"sort"
	"strings"
)

// CoverCount 返回覆盖点 (x, y) 的传感器数量。
func CoverCount(sensors []Sensor, x, y float64) int {
	n := 0
	for _, s := range sensors {
		if s.Rect.Contains(x, y) {
			n++
		}
	}
	return n
}

// Feasible 报告被至少 k 个范围覆盖的区域是否非空。
// 退化（零面积）矩形不产生可行区域，计算时忽略。
func Feasible(sensors []Sensor, k int) bool {
	if k <= 0 {
		return true
	}
	sensors = nonDegenerate(sensors)
	if len(sensors) < k {
		return false
	}
	xs, ys := gridLines(sensors)
	for i := 0; i+1 < len(xs); i++ {
		mx := (xs[i] + xs[i+1]) / 2
		for j := 0; j+1 < len(ys); j++ {
			my := (ys[j] + ys[j+1]) / 2
			if CoverCount(sensors, mx, my) >= k {
				return true
			}
		}
	}
	return false
}

// nonDegenerate 过滤掉零面积的退化矩形。
func nonDegenerate(sensors []Sensor) []Sensor {
	out := make([]Sensor, 0, len(sensors))
	for _, s := range sensors {
		if !s.Rect.Empty() {
			out = append(out, s)
		}
	}
	return out
}

// gridLines 收集所有矩形边界的 x/y 坐标并排序，用于坐标压缩。
func gridLines(sensors []Sensor) (xs, ys []float64) {
	xset := map[float64]struct{}{}
	yset := map[float64]struct{}{}
	for _, s := range sensors {
		r := s.Rect
		if r.Empty() {
			continue
		}
		xset[r.MinX] = struct{}{}
		xset[r.MaxX] = struct{}{}
		yset[r.MinY] = struct{}{}
		yset[r.MaxY] = struct{}{}
	}
	for x := range xset {
		xs = append(xs, x)
	}
	for y := range yset {
		ys = append(ys, y)
	}
	sort.Float64s(xs)
	sort.Float64s(ys)
	return xs, ys
}

// FeasibleRegion 计算被至少 k 个传感器范围覆盖的可行区域。
//
// 返回规范化分解：若干互不重叠的矩形，按 (MinX, MinY, MaxX, MaxY) 排序。
// 每个矩形内部覆盖集合恒定，Sources 即为覆盖它的全部传感器 ID（升序，
// 数量 >= k）。退化（零面积）矩形不产生可行区域，计算时忽略。
// k <= 0 或无可行区域时返回 nil。
func FeasibleRegion(sensors []Sensor, k int) []Region {
	if k <= 0 {
		return nil
	}
	sensors = nonDegenerate(sensors)
	if len(sensors) < k {
		return nil
	}
	xs, ys := gridLines(sensors)
	nx, ny := len(xs)-1, len(ys)-1
	if nx <= 0 || ny <= 0 {
		return nil
	}
	// 每个单元格记录覆盖它的传感器位掩码（覆盖数 < k 记 0）。
	masks := make([][]uint64, ny)
	for j := 0; j < ny; j++ {
		masks[j] = make([]uint64, nx)
		my := (ys[j] + ys[j+1]) / 2
		for i := 0; i < nx; i++ {
			mx := (xs[i] + xs[i+1]) / 2
			var m uint64
			for idx, s := range sensors {
				if s.Rect.Contains(mx, my) {
					m |= 1 << uint(idx)
				}
			}
			if bits.OnesCount64(m) >= k {
				masks[j][i] = m
			}
		}
	}
	// 规范分解：每行取掩码相同的极大水平段，纵向合并列区间与掩码均相同的相邻段。
	type xrun struct {
		lo, hi int    // 覆盖的单元格列区间 [lo, hi]
		mask   uint64 // 该段的覆盖传感器集合
	}
	active := map[xrun]int{} // 延续中的段 -> 起始行
	var regions []Region
	closeRun := func(r xrun, j0, j1 int) {
		rect := Rect{MinX: xs[r.lo], MaxX: xs[r.hi+1], MinY: ys[j0], MaxY: ys[j1]}
		regions = append(regions, Region{Rect: rect, Sources: sourcesOf(sensors, r.mask)})
	}
	for j := 0; j < ny; j++ {
		cur := map[xrun]bool{}
		for i := 0; i < nx; {
			m := masks[j][i]
			if m == 0 {
				i++
				continue
			}
			lo := i
			for i < nx && masks[j][i] == m {
				i++
			}
			cur[xrun{lo, i - 1, m}] = true
		}
		for r, j0 := range active {
			if !cur[r] {
				closeRun(r, j0, j)
				delete(active, r)
			}
		}
		for r := range cur {
			if _, ok := active[r]; !ok {
				active[r] = j
			}
		}
	}
	for r, j0 := range active {
		closeRun(r, j0, ny)
	}
	sortRegions(regions)
	return regions
}

// sourcesOf 返回掩码 mask 中的传感器 ID（升序）。
func sourcesOf(sensors []Sensor, mask uint64) []string {
	var ids []string
	for i, s := range sensors {
		if mask>>uint(i)&1 == 1 {
			ids = append(ids, s.ID)
		}
	}
	sort.Strings(ids)
	return ids
}

// sortRegions 按坐标字典序排序，坐标相同再按来源排序，保证输出规范且确定。
func sortRegions(regions []Region) {
	sort.Slice(regions, func(a, b int) bool {
		ra, rb := regions[a].Rect, regions[b].Rect
		if ra.MinX != rb.MinX {
			return ra.MinX < rb.MinX
		}
		if ra.MinY != rb.MinY {
			return ra.MinY < rb.MinY
		}
		if ra.MaxX != rb.MaxX {
			return ra.MaxX < rb.MaxX
		}
		if ra.MaxY != rb.MaxY {
			return ra.MaxY < rb.MaxY
		}
		return strings.Join(regions[a].Sources, "\x00") < strings.Join(regions[b].Sources, "\x00")
	})
}
