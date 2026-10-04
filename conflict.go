package locate

import (
	"math"
	"strings"
)

// MaxSensors 为题设允许的传感器数量上限（子集枚举规模为 2^MaxSensors）。
const MaxSensors = 18

// maxConsistentMask 枚举所有子集，返回公共交非空且总置信权最大的子集位掩码。
// 平局时取数量更多者，再按 ID 连接串字典序取小者，保证结果确定。
func maxConsistentMask(sensors []Sensor) uint64 {
	n := len(sensors)
	var best uint64
	bestW := math.Inf(-1)
	bestSize := -1
	bestKey := ""
	for mask := uint64(1); mask < (uint64(1) << uint(n)); mask++ {
		loX, loY := math.Inf(-1), math.Inf(-1)
		hiX, hiY := math.Inf(1), math.Inf(1)
		w := 0.0
		size := 0
		for i := 0; i < n; i++ {
			if mask>>uint(i)&1 == 0 {
				continue
			}
			r := sensors[i].Rect
			if r.MinX > loX {
				loX = r.MinX
			}
			if r.MaxX < hiX {
				hiX = r.MaxX
			}
			if r.MinY > loY {
				loY = r.MinY
			}
			if r.MaxY < hiY {
				hiY = r.MaxY
			}
			w += sensors[i].Weight
			size++
		}
		if loX > hiX || loY > hiY {
			continue // 公共交为空
		}
		if w > bestW || (w == bestW && size > bestSize) ||
			(w == bestW && size == bestSize && maskKey(sensors, mask) < bestKey) {
			best, bestW, bestSize = mask, w, size
			bestKey = maskKey(sensors, mask)
		}
	}
	return best
}

func maskKey(sensors []Sensor, mask uint64) string {
	ids := make([]string, 0, len(sensors))
	for i := range sensors {
		if mask>>uint(i)&1 == 1 {
			ids = append(ids, sensors[i].ID)
		}
	}
	return strings.Join(ids, "\x00")
}

// MaxConsistentSubset 返回公共交非空且总置信权最大的传感器子集（输入顺序）。
func MaxConsistentSubset(sensors []Sensor) []Sensor {
	if len(sensors) == 0 {
		return nil
	}
	mask := maxConsistentMask(sensors)
	var out []Sensor
	for i, s := range sensors {
		if mask>>uint(i)&1 == 1 {
			out = append(out, s)
		}
	}
	return out
}

// MinConflictSubset 在 k-覆盖可行区域为空时，返回需要剔除的最小冲突子集：
// 总置信权最小的传感器集合，剔除后剩余传感器恢复一致（公共交非空）。
//
// 注意：k-覆盖关于剔除是单调的（剔除不会增加覆盖数），因此“剔除后恢复
// k-覆盖”不可行；这里采用一致的恢复目标——剩余传感器存在公共交，
// 即被剔除者是导致不一致的冲突源。平局时剔除数量更少、ID 字典序更小者优先。
//
// 若原本 k-覆盖即非空，或无需剔除（剩余传感器本已一致，仅数量不足 k），
// 返回 ok=false。
func MinConflictSubset(sensors []Sensor, k int) (removed []Sensor, ok bool) {
	if Feasible(sensors, k) {
		return nil, false
	}
	if len(sensors) == 0 {
		return nil, false
	}
	keep := maxConsistentMask(sensors)
	full := (uint64(1) << uint(len(sensors))) - 1
	drop := full &^ keep
	if drop == 0 {
		return nil, false
	}
	for i, s := range sensors {
		if drop>>uint(i)&1 == 1 {
			removed = append(removed, s)
		}
	}
	return removed, true
}
