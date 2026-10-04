package locate

import (
	"math"
	"math/rand"
	"reflect"
	"testing"
)

// consistent 报告传感器集合是否存在非空公共交。
func consistent(ss []Sensor) bool {
	if len(ss) == 0 {
		return false
	}
	loX, loY := math.Inf(-1), math.Inf(-1)
	hiX, hiY := math.Inf(1), math.Inf(1)
	for _, s := range ss {
		if s.Rect.MinX > loX {
			loX = s.Rect.MinX
		}
		if s.Rect.MaxX < hiX {
			hiX = s.Rect.MaxX
		}
		if s.Rect.MinY > loY {
			loY = s.Rect.MinY
		}
		if s.Rect.MaxY < hiY {
			hiY = s.Rect.MaxY
		}
	}
	return loX <= hiX && loY <= hiY
}

func weightOf(ss []Sensor) float64 {
	w := 0.0
	for _, s := range ss {
		w += s.Weight
	}
	return w
}

func idsOf(ss []Sensor) []string {
	var ids []string
	for _, s := range ss {
		ids = append(ids, s.ID)
	}
	return ids
}

func TestMinConflictSubsetBasic(t *testing.T) {
	sensors := []Sensor{
		{ID: "A", Rect: R(0, 0, 3, 3), Weight: 10},
		{ID: "B", Rect: R(1, 1, 4, 4), Weight: 8},
		{ID: "C", Rect: R(3.5, 3.5, 6, 6), Weight: 1},
	}
	if Feasible(sensors, 3) {
		t.Fatalf("前置条件失败: k=3 应不可行")
	}
	removed, ok := MinConflictSubset(sensors, 3)
	if !ok {
		t.Fatalf("应给出冲突子集")
	}
	if got := idsOf(removed); !reflect.DeepEqual(got, []string{"C"}) {
		t.Fatalf("removed = %v, want [C]", got)
	}
}

// 最小权剔除可能需要剔除多个传感器。
func TestMinConflictSubsetWeightOverCount(t *testing.T) {
	sensors := []Sensor{
		{ID: "A", Rect: R(0, 0, 1, 1), Weight: 1},
		{ID: "B", Rect: R(2, 2, 3, 3), Weight: 1},
		{ID: "C", Rect: R(5, 5, 6, 6), Weight: 5},
	}
	removed, ok := MinConflictSubset(sensors, 2)
	if !ok {
		t.Fatalf("应给出冲突子集")
	}
	if got := idsOf(removed); !reflect.DeepEqual(got, []string{"A", "B"}) {
		t.Fatalf("removed = %v, want [A B]", got)
	}
}

func TestMinConflictSubsetFeasibleReturnsFalse(t *testing.T) {
	sensors := []Sensor{
		{ID: "A", Rect: R(0, 0, 2, 2), Weight: 1},
		{ID: "B", Rect: R(1, 1, 3, 3), Weight: 1},
	}
	if _, ok := MinConflictSubset(sensors, 2); ok {
		t.Fatalf("本已可行时不应给出冲突子集")
	}
}

func TestMaxConsistentSubset(t *testing.T) {
	sensors := []Sensor{
		{ID: "A", Rect: R(0, 0, 2, 2), Weight: 1},
		{ID: "B", Rect: R(1, 1, 3, 3), Weight: 2},
		{ID: "C", Rect: R(2.5, 2.5, 4, 4), Weight: 4},
	}
	got := idsOf(MaxConsistentSubset(sensors))
	if !reflect.DeepEqual(got, []string{"B", "C"}) {
		t.Fatalf("MaxConsistentSubset = %v, want [B C]", got)
	}
}

// 子集检查核对：穷举所有剔除子集，验证返回的冲突子集确实恢复一致且总权最小。
func TestMinConflictSubsetVerifyByEnumeration(t *testing.T) {
	r := rand.New(rand.NewSource(99))
	for iter := 0; iter < 150; iter++ {
		n := 2 + r.Intn(6) // 2..7
		sensors := randSensors(r, n)
		k := 1 + r.Intn(n+2)
		removed, ok := MinConflictSubset(sensors, k)

		if Feasible(sensors, k) {
			if ok {
				t.Fatalf("iter %d: 本已可行却给出冲突子集 %v", iter, idsOf(removed))
			}
			continue
		}

		// 穷举所有剔除子集，求恢复一致的最小总权。
		bestW := math.Inf(1)
		found := false
		for mask := uint64(1); mask < (uint64(1) << uint(n)); mask++ {
			var keep []Sensor
			w := 0.0
			for i := 0; i < n; i++ {
				if mask>>uint(i)&1 == 1 {
					w += sensors[i].Weight
				} else {
					keep = append(keep, sensors[i])
				}
			}
			if consistent(keep) && w < bestW {
				bestW, found = w, true
			}
		}

		if !ok {
			// 仅当任何剔除都无意义（剩余本已一致，仅数量不足 k）时允许。
			if found && consistent(sensors) == false {
				t.Fatalf("iter %d: 存在有效剔除但函数返回 ok=false", iter)
			}
			continue
		}

		// 1) 剔除后剩余传感器必须恢复一致。
		drop := map[string]bool{}
		for _, s := range removed {
			drop[s.ID] = true
		}
		var keep []Sensor
		for _, s := range sensors {
			if !drop[s.ID] {
				keep = append(keep, s)
			}
		}
		if !consistent(keep) {
			t.Fatalf("iter %d: 剔除 %v 后剩余仍不一致", iter, idsOf(removed))
		}
		// 2) 总置信权必须等于穷举得到的最小值。
		if got := weightOf(removed); got != bestW {
			t.Fatalf("iter %d: 剔除权 %v != 最小权 %v (removed=%v)", iter, got, bestW, idsOf(removed))
		}
		// 3) 确定性。
		again, ok2 := MinConflictSubset(sensors, k)
		if ok2 != ok || !reflect.DeepEqual(idsOf(again), idsOf(removed)) {
			t.Fatalf("iter %d: 结果不确定", iter)
		}
	}
}

// 上限规模（18 个传感器）的冒烟测试，确认子集枚举在约束内可用。
func TestMinConflictSubsetMaxSensors(t *testing.T) {
	var sensors []Sensor
	for i := 0; i < MaxSensors; i++ {
		x := float64(i * 10) // 全部两两不相交
		sensors = append(sensors, Sensor{
			ID:     string(rune('A' + i)),
			Rect:   R(x, 0, x+1, 1),
			Weight: float64(i + 1),
		})
	}
	removed, ok := MinConflictSubset(sensors, 2)
	if !ok {
		t.Fatalf("应给出冲突子集")
	}
	// 保留权最大的单个传感器（权 18），剔除其余 17 个。
	if len(removed) != MaxSensors-1 {
		t.Fatalf("len(removed) = %d, want %d", len(removed), MaxSensors-1)
	}
	if got := weightOf(removed); got != float64((1+17)*17/2) {
		t.Fatalf("weight = %v", got)
	}
}
