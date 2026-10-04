package locate

import (
	"fmt"
	"math"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

func TestNormalizeRect(t *testing.T) {
	r := R(4, 4, 0, 0)
	want := Rect{MinX: 0, MinY: 0, MaxX: 4, MaxY: 4}
	if r != want {
		t.Fatalf("R(4,4,0,0) = %+v, want %+v", r, want)
	}
	if !r.Contains(2, 2) || r.Contains(5, 2) {
		t.Fatalf("Contains 异常")
	}
	if got := R(0, 0, 3, 2).Area(); got != 6 {
		t.Fatalf("Area = %v, want 6", got)
	}
}

func TestFeasibleRegionBasic(t *testing.T) {
	sensors := []Sensor{
		{ID: "A", Rect: R(0, 0, 4, 4), Weight: 1},
		{ID: "B", Rect: R(2, 2, 6, 6), Weight: 1},
	}
	got := FeasibleRegion(sensors, 2)
	want := []Region{{Rect: R(2, 2, 4, 4), Sources: []string{"A", "B"}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("FeasibleRegion = %+v, want %+v", got, want)
	}
	if !Feasible(sensors, 2) {
		t.Fatalf("Feasible(k=2) 应为 true")
	}
	if got := FeasibleRegion(sensors, 3); got != nil {
		t.Fatalf("k=3 应无可行区域, got %+v", got)
	}
}

// 三个矩形构成十字形 k=2 覆盖，校验规范分解与来源。
func TestFeasibleRegionSourcesAndShape(t *testing.T) {
	sensors := []Sensor{
		{ID: "A", Rect: R(0, 0, 4, 2), Weight: 1},
		{ID: "B", Rect: R(0, 1, 4, 3), Weight: 1},
		{ID: "C", Rect: R(2, 0, 3, 4), Weight: 1},
	}
	got := FeasibleRegion(sensors, 2)
	want := []Region{
		{Rect: R(0, 1, 2, 2), Sources: []string{"A", "B"}},
		{Rect: R(2, 0, 3, 1), Sources: []string{"A", "C"}},
		{Rect: R(2, 1, 3, 2), Sources: []string{"A", "B", "C"}},
		{Rect: R(2, 2, 3, 3), Sources: []string{"B", "C"}},
		{Rect: R(3, 1, 4, 2), Sources: []string{"A", "B"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("FeasibleRegion = %+v, want %+v", got, want)
	}
}

func TestFeasibleRegionK1Union(t *testing.T) {
	sensors := []Sensor{
		{ID: "B", Rect: R(2, 2, 3, 3), Weight: 1},
		{ID: "A", Rect: R(0, 0, 1, 1), Weight: 1},
	}
	got := FeasibleRegion(sensors, 1)
	want := []Region{
		{Rect: R(0, 0, 1, 1), Sources: []string{"A"}},
		{Rect: R(2, 2, 3, 3), Sources: []string{"B"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("FeasibleRegion = %+v, want %+v", got, want)
	}
}

func randSensors(r *rand.Rand, n int) []Sensor {
	out := make([]Sensor, n)
	for i := range out {
		x0 := float64(r.Intn(8))
		y0 := float64(r.Intn(8))
		x1 := x0 + float64(r.Intn(4)) // 允许退化矩形
		y1 := y0 + float64(r.Intn(4))
		out[i] = Sensor{
			ID:     fmt.Sprintf("S%d", i),
			Rect:   R(x0, y0, x1, y1),
			Weight: float64(1 + r.Intn(9)),
		}
	}
	return out
}

// 小网格穷举核对：逐点比较“在可行区域内”与“覆盖数 >= k”，并核对总面积。
func TestFeasibleRegionGridBruteForce(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	const step = 0.25
	for iter := 0; iter < 200; iter++ {
		n := 1 + r.Intn(6)
		sensors := randSensors(r, n)
		k := 1 + r.Intn(n+1)
		regions := FeasibleRegion(sensors, k)

		// 输出必须按规范排序。
		if !sort.SliceIsSorted(regions, func(a, b int) bool {
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
			return ra.MaxY < rb.MaxY
		}) {
			t.Fatalf("iter %d: 区域未按规范排序: %+v", iter, regions)
		}

		var area float64
		for _, rg := range regions {
			area += rg.Rect.Area()
			if len(rg.Sources) < k {
				t.Fatalf("iter %d: 区域 %+v 来源数 %d < k=%d", iter, rg, len(rg.Sources), k)
			}
			if !sort.StringsAreSorted(rg.Sources) {
				t.Fatalf("iter %d: 来源未排序: %+v", iter, rg)
			}
		}

		var wantArea float64
		// 随机矩形坐标落在 [0,10]，采样网格覆盖 [0,16)。
		for xi := 0; xi < 64; xi++ {
			x := 0.125 + step*float64(xi)
			for yi := 0; yi < 64; yi++ {
				y := 0.125 + step*float64(yi)
				inside := false
				for _, rg := range regions {
					if rg.Rect.Contains(x, y) {
						inside = true
						break
					}
				}
				want := CoverCount(sensors, x, y) >= k
				if inside != want {
					t.Fatalf("iter %d: 点 (%v,%v) inside=%v want=%v, sensors=%+v k=%d",
						iter, x, y, inside, want, sensors, k)
				}
				if want {
					wantArea += step * step
				}
			}
		}
		if math.Abs(area-wantArea) > 1e-9 {
			t.Fatalf("iter %d: 区域总面积 %v != 网格面积 %v", iter, area, wantArea)
		}
		if got := Feasible(sensors, k); got != (len(regions) > 0) {
			t.Fatalf("iter %d: Feasible=%v 与区域数量 %d 不一致", iter, got, len(regions))
		}
	}
}

func TestFeasibleRegionDeterministic(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	sensors := randSensors(r, 6)
	first := FeasibleRegion(sensors, 3)
	for i := 0; i < 10; i++ {
		if got := FeasibleRegion(sensors, 3); !reflect.DeepEqual(got, first) {
			t.Fatalf("结果不确定: %+v vs %+v", got, first)
		}
	}
}
