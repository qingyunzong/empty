package locate

import (
	"math"
	"sort"
	"testing"
)

func sensorsOf(specs ...interface{}) []Sensor {
	var out []Sensor
	for i := 0; i < len(specs); i += 3 {
		id := specs[i].(string)
		r := specs[i+1].(Rect)
		w := specs[i+2].(float64)
		out = append(out, Sensor{ID: id, Rect: r, Weight: w})
	}
	return out
}

func TestCanonical(t *testing.T) {
	r := Rect{MinX: 5, MinY: 3, MaxX: -2, MaxY: 1}.Canonical()
	want := Rect{MinX: -2, MinY: 1, MaxX: 5, MaxY: 3}
	if r != want {
		t.Fatalf("Canonical = %+v, want %+v", r, want)
	}
}

func TestCoveredRegionBasic(t *testing.T) {
	sensors := sensorsOf(
		"A", Rect{0, 0, 4, 4}, 1.0,
		"B", Rect{2, 0, 6, 4}, 2.0,
		"C", Rect{1, 1, 3, 3}, 4.0,
	)
	got := CoveredRegion(sensors, 2)
	want := []RegionRect{
		{Rect: Rect{1, 1, 2, 3}, Sources: []string{"A", "C"}, Weight: 5},
		{Rect: Rect{2, 0, 4, 1}, Sources: []string{"A", "B"}, Weight: 3},
		{Rect: Rect{2, 1, 3, 3}, Sources: []string{"A", "B", "C"}, Weight: 7},
		{Rect: Rect{2, 3, 4, 4}, Sources: []string{"A", "B"}, Weight: 3},
		{Rect: Rect{3, 1, 4, 3}, Sources: []string{"A", "B"}, Weight: 3},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d rects %v, want %d", len(got), got, len(want))
	}
	for i := range want {
		if got[i].Rect != want[i].Rect {
			t.Errorf("rect[%d] = %+v, want %+v", i, got[i].Rect, want[i].Rect)
		}
		if !equalStrings(got[i].Sources, want[i].Sources) {
			t.Errorf("sources[%d] = %v, want %v", i, got[i].Sources, want[i].Sources)
		}
		if got[i].Weight != want[i].Weight {
			t.Errorf("weight[%d] = %v, want %v", i, got[i].Weight, want[i].Weight)
		}
	}
	var area float64
	for _, r := range got {
		area += r.Rect.Area()
	}
	if area != 10 {
		t.Errorf("total area = %v, want 10", area)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestGridExhaustive 小网格穷举核对：对细密网格的每个采样点，
// 直接统计覆盖它的传感器数，与 CoveredRegion 的输出互相验证。
func TestGridExhaustive(t *testing.T) {
	sensors := sensorsOf(
		"S1", Rect{0.1, 0.2, 3.7, 2.9}, 0.9,
		"S2", Rect{1.3, 0.0, 4.2, 1.8}, 0.6,
		"S3", Rect{2.0, 1.0, 5.1, 3.3}, 0.8,
		"S4", Rect{0.4, 2.2, 2.6, 4.0}, 0.7,
	)
	const k = 2
	region := CoveredRegion(sensors, k)
	if len(region) == 0 {
		t.Fatal("region is empty, want non-empty")
	}

	// 输出矩形自身性质的核对。
	for _, rr := range region {
		if rr.Rect != rr.Rect.Canonical() || rr.Rect.Empty() {
			t.Errorf("rect %+v is not canonical or empty", rr.Rect)
		}
		if len(rr.Sources) < k {
			t.Errorf("rect %+v has %d sources < k=%d", rr.Rect, len(rr.Sources), k)
		}
		var w float64
		byID := make(map[string]Sensor)
		for _, s := range sensors {
			byID[s.ID] = s
		}
		for _, id := range rr.Sources {
			s := byID[id]
			if !s.Rect.Canonical().ContainsRect(rr.Rect) {
				t.Errorf("source %s does not fully cover %+v", id, rr.Rect)
			}
			w += s.Weight
		}
		if rr.Weight != w {
			t.Errorf("rect %+v weight = %v, want %v", rr.Rect, rr.Weight, w)
		}
	}

	// 网格穷举：采样点覆盖计数与区域成员资格必须一致。
	const step = 0.025
	minX, minY, maxX, maxY := 0.0, 0.0, 5.2, 4.1
	var gridArea, regionArea float64
	for x := minX + step/2; x < maxX; x += step {
		for y := minY + step/2; y < maxY; y += step {
			cnt := 0
			for _, s := range sensors {
				if s.Rect.Canonical().ContainsPoint(x, y) {
					cnt++
				}
			}
			inRegion := false
			for _, rr := range region {
				if rr.Rect.ContainsPoint(x, y) {
					inRegion = true
					break
				}
			}
			if (cnt >= k) != inRegion {
				t.Fatalf("mismatch at (%v,%v): grid count=%d, inRegion=%v", x, y, cnt, inRegion)
			}
			if cnt >= k {
				gridArea += step * step
			}
		}
	}
	for _, rr := range region {
		regionArea += rr.Rect.Area()
	}
	if math.Abs(gridArea-regionArea) > 0.05 {
		t.Fatalf("area mismatch: grid=%v region=%v", gridArea, regionArea)
	}
}

// TestConflictSubset 可行区域为空时给出最小冲突子集，
// 并用子集检查核对：该子集交集为空，且不存在更小的冲突子集。
func TestConflictSubset(t *testing.T) {
	sensors := sensorsOf(
		"A", Rect{0, 0, 2, 2}, 1.0,
		"B", Rect{3, 0, 5, 2}, 2.0,
		"C", Rect{0.5, 0.5, 4, 1.5}, 3.0,
	)
	if got := CoveredRegion(sensors, 3); len(got) != 0 {
		t.Fatalf("k=3 region = %v, want empty", got)
	}
	// k=2 时 A∩C 与 B∩C 非空，可行区域应存在。
	if got := CoveredRegion(sensors, 2); len(got) == 0 {
		t.Fatal("k=2 region is empty, want non-empty")
	}

	conflict, err := MinConflictSubset(sensors)
	if err != nil {
		t.Fatal(err)
	}
	if len(conflict) != 2 || conflict[0].ID != "A" || conflict[1].ID != "B" {
		t.Fatalf("conflict = %v, want [A B]", idsOf(conflict))
	}

	// 子集检查核对 1：返回子集的公共交集必须为空。
	var rects []Rect
	for _, s := range conflict {
		rects = append(rects, s.Rect.Canonical())
	}
	if _, ok := IntersectAll(rects); ok {
		t.Fatal("conflict subset intersection is non-empty")
	}
	// 子集检查核对 2：蛮力确认不存在尺寸更小的冲突子集。
	assertMinimality(t, sensors, len(conflict))
}

// TestConflictSubsetWeightTieBreak 同尺寸最小冲突子集取置信权之和最大者。
func TestConflictSubsetWeightTieBreak(t *testing.T) {
	sensors := sensorsOf(
		"A", Rect{0, 0, 1, 1}, 1.0,
		"B", Rect{2, 0, 3, 1}, 5.0,
		"C", Rect{4, 0, 5, 1}, 3.0,
	)
	conflict, err := MinConflictSubset(sensors)
	if err != nil {
		t.Fatal(err)
	}
	if len(conflict) != 2 || conflict[0].ID != "B" || conflict[1].ID != "C" {
		t.Fatalf("conflict = %v, want [B C] (max weight pair)", idsOf(conflict))
	}
	assertMinimality(t, sensors, len(conflict))
}

// TestConflictSubsetLarger 6 个传感器、k=4 不可行的场景，
// 核对最小冲突子集及其极小性。
func TestConflictSubsetLarger(t *testing.T) {
	sensors := sensorsOf(
		"N1", Rect{0, 0, 4, 4}, 1.0,
		"N2", Rect{1, 1, 5, 5}, 1.0,
		"N3", Rect{0, 2, 4, 6}, 1.0,
		"N4", Rect{2, 0, 6, 4}, 1.0,
		"F1", Rect{10, 10, 12, 12}, 2.0,
		"F2", Rect{11, 11, 13, 13}, 3.0,
	)
	if got := CoveredRegion(sensors, 5); len(got) != 0 {
		t.Fatalf("k=5 region = %v, want empty", got)
	}
	conflict, err := MinConflictSubset(sensors)
	if err != nil {
		t.Fatal(err)
	}
	// 近端四矩形交集 [2,2]x[2,4] 非空，远端两矩形与近端组不相交，
	// 最小冲突子集应为近端其一 + 远端其一，尺寸 2，权重最大者为 {F2, N*}。
	if len(conflict) != 2 {
		t.Fatalf("conflict size = %d, want 2: %v", len(conflict), idsOf(conflict))
	}
	var rects []Rect
	for _, s := range conflict {
		rects = append(rects, s.Rect.Canonical())
	}
	if _, ok := IntersectAll(rects); ok {
		t.Fatal("conflict subset intersection is non-empty")
	}
	assertMinimality(t, sensors, len(conflict))
}

func TestNoConflict(t *testing.T) {
	sensors := sensorsOf(
		"A", Rect{0, 0, 4, 4}, 1.0,
		"B", Rect{1, 1, 5, 5}, 1.0,
		"C", Rect{2, 2, 6, 6}, 1.0,
	)
	conflict, err := MinConflictSubset(sensors)
	if err != nil {
		t.Fatal(err)
	}
	if conflict != nil {
		t.Fatalf("conflict = %v, want nil (common intersection non-empty)", idsOf(conflict))
	}
}

func TestTooManySensors(t *testing.T) {
	sensors := make([]Sensor, MaxSensors+1)
	for i := range sensors {
		sensors[i] = Sensor{ID: string(rune('a' + i)), Rect: Rect{0, 0, 1, 1}}
	}
	if _, err := MinConflictSubset(sensors); err != ErrTooManySensors {
		t.Fatalf("err = %v, want ErrTooManySensors", err)
	}
}

// assertMinimality 蛮力枚举所有尺寸小于 got 的子集，
// 核对它们的公共交集均非空，即返回的冲突子集确实最小。
func assertMinimality(t *testing.T, sensors []Sensor, got int) {
	t.Helper()
	n := len(sensors)
	rects := make([]Rect, n)
	for i, s := range sensors {
		rects[i] = s.Rect.Canonical()
	}
	for mask := 1; mask < 1<<n; mask++ {
		if popcount(mask) >= got {
			continue
		}
		var sub []Rect
		for i := 0; i < n; i++ {
			if mask&(1<<i) != 0 {
				sub = append(sub, rects[i])
			}
		}
		if _, ok := IntersectAll(sub); !ok {
			t.Fatalf("found smaller conflict subset of size %d (mask %b)", popcount(mask), mask)
		}
	}
}

func idsOf(sensors []Sensor) []string {
	ids := make([]string, len(sensors))
	for i, s := range sensors {
		ids[i] = s.ID
	}
	sort.Strings(ids)
	return ids
}
