package formal

import (
	"fmt"
	"math"
	"testing"
)

// naiveExact 是与产品代码完全独立的朴素比例参考：直接按配置百分比计算每个
// 版本在 n 个请求下的精确期望 w*n/100。无状态在线顺序分配无法在每个前缀都
// 给出全局最优的 Hamilton 整数解（信息论上不可能预知未来 n），其可验证的
// 正确标准是：偏差严格小于 1 个完整名额（|count-exact| < 2 的整数形式），
// 总和严格守恒，并且在 100 的整数倍处与配置权重精确相等。
func naiveExact(weights []int, n int) []float64 {
	exact := make([]float64, len(weights))
	for i, w := range weights {
		exact[i] = float64(w) * float64(n) / 100
	}
	return exact
}

func primaryWeights(c Config) ([]string, []int) {
	ids := make([]string, 0, len(c.Versions))
	ws := make([]int, 0, len(c.Versions))
	for _, v := range c.Versions {
		if v.Role != RoleShadow {
			ids = append(ids, v.ID)
			ws = append(ws, v.Weight)
		}
	}
	return ids, ws
}

// TestExhaustiveProportions 穷举所有 3 版本权重组合（和为 100），对每个请求序列
// 前缀（n=1..maxN）逐拍核对在线拆分计数与朴素比例分配完全一致，并验证守恒。
func TestExhaustiveProportions(t *testing.T) {
	const maxN = 240
	for w1 := 0; w1 <= 100; w1++ {
		for w2 := 0; w2 <= 100-w1; w2++ {
			w3 := 100 - w1 - w2
			weights := []int{w1, w2, w3}
			cfg := Config{Versions: []Version{
				{ID: "v1", Role: RoleStable, Weight: w1},
				{ID: "v2", Role: RoleStable, Weight: w2},
				{ID: "v3", Role: RoleStable, Weight: w3},
			}}
			s, err := NewSplitter(cfg)
			if err != nil {
				t.Fatalf("NewSplitter(%v): %v", weights, err)
			}
			for n := 1; n <= maxN; n++ {
				a, _ := s.Route()
				a.Release()

				s.mu.Lock()
				got := s.primary
				exact := naiveExact(weights, n)
				var total int64
				for i, w := range weights {
					id := fmt.Sprintf("v%d", i+1)
					dev := math.Abs(float64(got[id]) - exact[i])
					if dev >= 2 {
						s.mu.Unlock()
						t.Fatalf("weights=%v n=%d %s count=%d exact=%.2f deviation=%.2f >= 2",
							weights, n, id, got[id], exact[i], dev)
					}
					if n%100 == 0 && got[id] != int64(w*n/100) {
						s.mu.Unlock()
						t.Fatalf("weights=%v n=%d %s count=%d must equal exact weight %d",
							weights, n, id, got[id], w*n/100)
					}
					total += got[id]
				}
				s.mu.Unlock()
				if total != int64(n) {
					t.Fatalf("weights=%v n=%d total=%d not conserved", weights, n, total)
				}
			}
		}
	}
}

// TestCanaryAndShadowProportions 验证带 canary 与 shadow 的配置：正式版本
// （含 canary）仍严格符合朴素比例分配，shadow 不进入任何正式计数。
func TestCanaryAndShadowProportions(t *testing.T) {
	cfg := Config{Versions: []Version{
		{ID: "stable", Role: RoleStable, Weight: 80},
		{ID: "canary", Role: RoleCanary, Weight: 15},
		{ID: "canary2", Role: RoleCanary, Weight: 5},
		{ID: "shadow", Role: RoleShadow, Weight: 0},
		{ID: "shadow2", Role: RoleShadow, Weight: 0},
	}}
	s, err := NewSplitter(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ids, weights := primaryWeights(cfg)
	const n = 500
	for i := 0; i < n; i++ {
		_, shadows := s.Route()
		if len(shadows) != 2 || shadows[0] != "shadow" || shadows[1] != "shadow2" {
			t.Fatalf("shadow targets mismatch: %v", shadows)
		}
	}
	stats := s.Stats()
	exact := naiveExact(weights, n)
	var total int64
	for i, id := range ids {
		dev := math.Abs(float64(stats.Primary[id]) - exact[i])
		if dev >= 2 {
			t.Fatalf("%s count=%d exact=%.2f deviation=%.2f", id, stats.Primary[id], exact[i], dev)
		}
		if _, ok := stats.Shadow[id]; ok {
			t.Fatalf("primary version %s leaked into shadow stats", id)
		}
		total += stats.Primary[id]
	}
	if total != n {
		t.Fatalf("primary total=%d want %d", total, n)
	}
	for _, id := range []string{"shadow", "shadow2"} {
		if stats.Shadow[id] != n {
			t.Fatalf("shadow %s count=%d want %d", id, stats.Shadow[id], n)
		}
		if _, ok := stats.Primary[id]; ok {
			t.Fatalf("shadow %s leaked into primary stats", id)
		}
	}
}

// TestExplicitSequence 用手工可算的小序列固定分配顺序，防止算法被悄悄改坏。
func TestExplicitSequence(t *testing.T) {
	cfg := Config{Versions: []Version{
		{ID: "a", Role: RoleStable, Weight: 70},
		{ID: "b", Role: RoleCanary, Weight: 30},
	}}
	s, err := NewSplitter(cfg)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]string, 0, 10)
	for i := 0; i < 10; i++ {
		a, _ := s.Route()
		got = append(got, a.VersionID())
		a.Release()
	}
	want := []string{"a", "b", "a", "a", "b", "a", "a", "b", "a", "a"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("sequence=%v want=%v", got, want)
	}
}

// TestConfigValidation 覆盖配置守恒与角色约束。
func TestConfigValidation(t *testing.T) {
	good := Config{Versions: []Version{
		{ID: "a", Weight: 60},
		{ID: "b", Role: RoleCanary, Weight: 40},
	}}
	if err := good.Validate(); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	bad := []Config{
		{},
		{Versions: []Version{{ID: "a", Weight: 100}, {ID: "a"}}},
		{Versions: []Version{{ID: "a", Weight: 90}, {ID: "b", Weight: 5}}},
		{Versions: []Version{{ID: "a", Weight: 50}, {ID: "b", Weight: 50, Role: RoleShadow}}},
		{Versions: []Version{{ID: "a", Role: RoleShadow}}},
		{Versions: []Version{{ID: "a", Weight: -1}, {ID: "b", Weight: 101}}},
	}
	for i, c := range bad {
		if err := c.Validate(); err == nil {
			t.Fatalf("bad config #%d accepted: %+v", i, c)
		}
		if _, err := NewSplitter(c); err == nil {
			t.Fatalf("NewSplitter accepted bad config #%d", i)
		}
	}
	s, _ := NewSplitter(good)
	if err := s.UpdateConfig(bad[2]); err == nil {
		t.Fatal("UpdateConfig accepted invalid config")
	}
	if s.Generation() != 1 {
		t.Fatalf("generation=%d, failed update must not advance generation", s.Generation())
	}
}
