package locate

import "sort"

// MaxSensors 为冲突子集穷举支持的传感器数量上限（2^18 子集枚举）。
const MaxSensors = 18

// MinConflictSubset 在公共交集为空时，返回尺寸最小的冲突子集：
// 即传感器数量最少、且其矩形公共交集为空的子集，作为不可行的最小证书。
// 若存在多个同尺寸的最小冲突子集，返回置信权之和最大者；
// 权重也相同则按 ID 字典序取前者，保证输出确定。
// 若全体矩形的公共交集非空，则不存在冲突，返回 nil。
// 传感器数量超过 MaxSensors 时返回错误。
func MinConflictSubset(sensors []Sensor) ([]Sensor, error) {
	n := len(sensors)
	if n > MaxSensors {
		return nil, ErrTooManySensors
	}
	rects := make([]Rect, n)
	for i, s := range sensors {
		rects[i] = s.Rect.Canonical()
	}
	if _, ok := IntersectAll(rects); ok {
		return nil, nil // 全体交集非空，无冲突
	}

	var best []int
	var bestWeight float64
	for size := 2; size <= n && best == nil; size++ {
		for mask := 0; mask < 1<<n; mask++ {
			if popcount(mask) != size {
				continue
			}
			var sub []Rect
			var idx []int
			var w float64
			for i := 0; i < n; i++ {
				if mask&(1<<i) != 0 {
					sub = append(sub, rects[i])
					idx = append(idx, i)
					w += sensors[i].Weight
				}
			}
			if _, ok := IntersectAll(sub); ok {
				continue
			}
			if best == nil || w > bestWeight ||
				(w == bestWeight && lessIDs(sensors, idx, best)) {
				best, bestWeight = idx, w
			}
		}
	}
	if best == nil {
		return nil, nil
	}
	out := make([]Sensor, len(best))
	for i, idx := range best {
		out[i] = sensors[idx]
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func popcount(v int) int {
	c := 0
	for v != 0 {
		v &= v - 1
		c++
	}
	return c
}

func lessIDs(sensors []Sensor, a, b []int) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if sensors[a[i]].ID != sensors[b[i]].ID {
			return sensors[a[i]].ID < sensors[b[i]].ID
		}
	}
	return len(a) < len(b)
}
