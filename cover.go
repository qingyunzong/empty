package locate

import (
	"fmt"
	"sort"
	"strings"
)

// CoveredRegion 计算被至少 k 个传感器矩形覆盖的可行区域。
//
// 算法：取所有矩形边作为坐标分割线，将平面切成基本单元；
// 每个单元内的覆盖集合恒定，保留覆盖数 >= k 的单元，
// 再按相同的覆盖来源集合合并为规范矩形输出。
// 返回的每块矩形附带完整覆盖它的来源传感器及置信权之和。
// 结果按 (MinX, MinY, MaxX, MaxY) 排序，输出确定。
func CoveredRegion(sensors []Sensor, k int) []RegionRect {
	if k <= 0 || len(sensors) == 0 {
		return nil
	}
	rs := make([]Rect, len(sensors))
	var xs, ys []float64
	for i, s := range sensors {
		rs[i] = s.Rect.Canonical()
		if rs[i].Empty() {
			continue
		}
		xs = append(xs, rs[i].MinX, rs[i].MaxX)
		ys = append(ys, rs[i].MinY, rs[i].MaxY)
	}
	if len(xs) == 0 {
		return nil
	}
	xs, ys = sortedUnique(xs), sortedUnique(ys)

	// cell 记录一个被 >=k 覆盖的基本单元及其来源签名。
	type cell struct {
		xi, yi int
		sig    string
		src    []int
	}
	var cells []cell
	for xi := 0; xi+1 < len(xs); xi++ {
		for yi := 0; yi+1 < len(ys); yi++ {
			c := Rect{MinX: xs[xi], MinY: ys[yi], MaxX: xs[xi+1], MaxY: ys[yi+1]}
			var src []int
			for i, r := range rs {
				if r.ContainsRect(c) {
					src = append(src, i)
				}
			}
			if len(src) >= k {
				cells = append(cells, cell{xi: xi, yi: yi, sig: sigOf(src), src: src})
			}
		}
	}
	if len(cells) == 0 {
		return nil
	}

	// 第一遍合并：同一行内、签名相同且 x 相邻的单元合成水平条带。
	type strip struct {
		xi0, xi1, yi int
		sig          string
		src          []int
	}
	key := func(xi, yi int, sig string) string { return fmt.Sprintf("%d/%d/%s", xi, yi, sig) }
	byCell := make(map[string]cell, len(cells))
	for _, c := range cells {
		byCell[key(c.xi, c.yi, c.sig)] = c
	}
	var strips []strip
	for _, c := range cells {
		if _, ok := byCell[key(c.xi-1, c.yi, c.sig)]; ok {
			continue // 不是条带起点
		}
		x1 := c.xi
		for {
			if _, ok := byCell[key(x1+1, c.yi, c.sig)]; !ok {
				break
			}
			x1++
		}
		strips = append(strips, strip{xi0: c.xi, xi1: x1, yi: c.yi, sig: c.sig, src: c.src})
	}

	// 第二遍合并：x 范围与签名相同、y 相邻的条带合成矩形。
	type rectKey struct {
		xi0, xi1 int
		sig      string
	}
	byRow := make(map[rectKey]map[int]strip) // key -> yi -> strip
	var order []rectKey
	for _, s := range strips {
		rk := rectKey{xi0: s.xi0, xi1: s.xi1, sig: s.sig}
		if byRow[rk] == nil {
			byRow[rk] = make(map[int]strip)
			order = append(order, rk)
		}
		byRow[rk][s.yi] = s
	}
	var out []RegionRect
	for _, rk := range order {
		rows := byRow[rk]
		y0 := -1
		for yi := 0; yi+1 < len(ys); yi++ {
			if _, ok := rows[yi]; ok {
				if y0 < 0 {
					y0 = yi
				}
				continue
			}
			if y0 >= 0 {
				out = append(out, buildRect(sensors, xs, ys, rk.xi0, rk.xi1, y0, yi-1, rows[y0].src))
				y0 = -1
			}
		}
		if y0 >= 0 {
			out = append(out, buildRect(sensors, xs, ys, rk.xi0, rk.xi1, y0, len(ys)-2, rows[y0].src))
		}
	}

	sort.Slice(out, func(i, j int) bool {
		a, b := out[i].Rect, out[j].Rect
		if a.MinX != b.MinX {
			return a.MinX < b.MinX
		}
		if a.MinY != b.MinY {
			return a.MinY < b.MinY
		}
		if a.MaxX != b.MaxX {
			return a.MaxX < b.MaxX
		}
		return a.MaxY < b.MaxY
	})
	return out
}

func buildRect(sensors []Sensor, xs, ys []float64, xi0, xi1, yi0, yi1 int, src []int) RegionRect {
	ids := make([]string, len(src))
	var w float64
	for i, idx := range src {
		ids[i] = sensors[idx].ID
		w += sensors[idx].Weight
	}
	sort.Strings(ids)
	return RegionRect{
		Rect:    Rect{MinX: xs[xi0], MinY: ys[yi0], MaxX: xs[xi1+1], MaxY: ys[yi1+1]},
		Sources: ids,
		Weight:  w,
	}
}

func sigOf(src []int) string {
	parts := make([]string, len(src))
	for i, s := range src {
		parts[i] = fmt.Sprint(s)
	}
	return strings.Join(parts, ",")
}
