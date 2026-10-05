// Package main 实现编组 CLI：把至多 18 节车厢按原序分成连续列车，
// 每列受长度、重量与危险品相邻规则约束，费用按车型计，
// 目标为总费用最小，平局时列数最少。
package main

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

// MaxCars 是题目允许的最大车厢数。
const MaxCars = 18

// eps 是浮点比较容差。
const eps = 1e-9

// Car 描述一节车厢。Hazard 为危险品品类，0 表示非危险品。
type Car struct {
	ID     string  `json:"id"`
	Type   string  `json:"type"`
	Length float64 `json:"length"`
	Weight float64 `json:"weight"`
	Hazard int     `json:"hazard"`
}

// Problem 是一次编组问题的完整输入。
type Problem struct {
	MaxLength float64            `json:"maxLength"` // 单列长度上限
	MaxWeight float64            `json:"maxWeight"` // 单列重量上限
	TrainBase float64            `json:"trainBase"` // 每列固定费用
	TypeCost  map[string]float64 `json:"typeCost"`  // 每列车内每种出现车型计一次费用
	Cars      []Car              `json:"cars"`
}

// Value 是目标值：先比总费用，再比列数。
type Value struct {
	Cost   float64
	Trains int
}

func better(a, b Value) bool {
	if math.Abs(a.Cost-b.Cost) > eps {
		return a.Cost < b.Cost
	}
	return a.Trains < b.Trains
}

// Validate 检查输入合法性。
func (p Problem) Validate() error {
	if len(p.Cars) == 0 {
		return errors.New("车厢列表为空")
	}
	if len(p.Cars) > MaxCars {
		return fmt.Errorf("车厢数 %d 超过上限 %d", len(p.Cars), MaxCars)
	}
	if p.MaxLength <= 0 || p.MaxWeight <= 0 {
		return fmt.Errorf("长度/重量上限必须为正: maxLength=%v maxWeight=%v", p.MaxLength, p.MaxWeight)
	}
	for i, c := range p.Cars {
		if c.ID == "" {
			return fmt.Errorf("第 %d 节车厢缺少 id", i)
		}
		if c.Type == "" {
			return fmt.Errorf("车厢 %s 缺少车型", c.ID)
		}
		if c.Length <= 0 || c.Weight <= 0 {
			return fmt.Errorf("车厢 %s 长度/重量必须为正", c.ID)
		}
		if c.Hazard < 0 {
			return fmt.Errorf("车厢 %s 危险品品类不能为负", c.ID)
		}
		if c.Length > p.MaxLength+eps || c.Weight > p.MaxWeight+eps {
			return fmt.Errorf("车厢 %s 单节即超限(长 %v 重 %v)，无可行编组", c.ID, c.Length, c.Weight)
		}
	}
	return nil
}

// hazardOK 检查区间 [i,j) 内危险品相邻规则：
// 相邻两节若均为危险品且品类不同，则不允许同列相邻。
func hazardOK(cars []Car, i, j int) bool {
	for k := i; k+1 < j; k++ {
		a, b := cars[k].Hazard, cars[k+1].Hazard
		if a != 0 && b != 0 && a != b {
			return false
		}
	}
	return true
}

// feasibleSegment 判断 cars[i:j] 能否组成一列合法列车。
func (p Problem) feasibleSegment(i, j int) bool {
	var length, weight float64
	for k := i; k < j; k++ {
		length += p.Cars[k].Length
		weight += p.Cars[k].Weight
	}
	if length > p.MaxLength+eps || weight > p.MaxWeight+eps {
		return false
	}
	return hazardOK(p.Cars, i, j)
}

// typeCostOf 返回车型 t 的费用，缺省为 1。
func (p Problem) typeCostOf(t string) float64 {
	if p.TypeCost != nil {
		if c, ok := p.TypeCost[t]; ok {
			return c
		}
	}
	return 1
}

// segmentCost 计算 cars[i:j] 组成一列的费用：
// 固定费用 TrainBase + 列内每种不同车型的车型费各计一次。
func (p Problem) segmentCost(i, j int) float64 {
	seen := map[string]bool{}
	cost := p.TrainBase
	for k := i; k < j; k++ {
		t := p.Cars[k].Type
		if !seen[t] {
			seen[t] = true
			cost += p.typeCostOf(t)
		}
	}
	return cost
}

// Solve 用前缀 DP 求最优切分，返回各段边界 cuts（含 0 与 n）及目标值。
// 若无可行编组返回 ok=false。
func (p Problem) Solve() (cuts []int, val Value, ok bool) {
	n := len(p.Cars)
	const inf = math.MaxFloat64
	dp := make([]Value, n+1)
	prev := make([]int, n+1)
	dp[0] = Value{0, 0}
	for i := 1; i <= n; i++ {
		dp[i] = Value{inf, math.MaxInt}
		prev[i] = -1
	}
	for j := 1; j <= n; j++ {
		for i := 0; i < j; i++ {
			if prev[i] == -1 && i != 0 {
				continue
			}
			if !p.feasibleSegment(i, j) {
				continue
			}
			cand := Value{dp[i].Cost + p.segmentCost(i, j), dp[i].Trains + 1}
			if better(cand, dp[j]) {
				dp[j] = cand
				prev[j] = i
			}
		}
	}
	if prev[n] == -1 {
		return nil, Value{}, false
	}
	var rev []int
	for at := n; at > 0; at = prev[at] {
		rev = append(rev, at)
	}
	cuts = append(cuts, 0)
	for k := len(rev) - 1; k >= 0; k-- {
		cuts = append(cuts, rev[k])
	}
	return cuts, dp[n], true
}

// Stats 是穷举所有切分后的对照统计。
type Stats struct {
	Total        int     // 全部切分数 2^(n-1)
	Feasible     int     // 可行切分数
	BestCost     float64 // 可行切分中的最小总费用
	BestCount    int     // 达到最小费用的切分数
	BestTrains   int     // 最小费用切分中的最少列数
	BestCutsList [][]int // 达到 (最小费用, 最少列数) 的全部切分
}

// splitValue 计算给定切分（cuts 含 0 与 n）的费用与列数；不可行返回 ok=false。
func (p Problem) splitValue(cuts []int) (Value, bool) {
	v := Value{0, len(cuts) - 1}
	for s := 0; s+1 < len(cuts); s++ {
		i, j := cuts[s], cuts[s+1]
		if !p.feasibleSegment(i, j) {
			return Value{}, false
		}
		v.Cost += p.segmentCost(i, j)
	}
	return v, true
}

// Exhaustive 穷举全部 2^(n-1) 种切分并统计对照结果。
func (p Problem) Exhaustive() Stats {
	n := len(p.Cars)
	st := Stats{Total: 1 << (n - 1), BestCost: math.MaxFloat64, BestTrains: math.MaxInt}
	for mask := 0; mask < st.Total; mask++ {
		cuts := []int{0}
		for k := 0; k < n-1; k++ {
			if mask>>k&1 == 1 {
				cuts = append(cuts, k+1)
			}
		}
		cuts = append(cuts, n)
		v, ok := p.splitValue(cuts)
		if !ok {
			continue
		}
		st.Feasible++
		switch {
		case v.Cost < st.BestCost-eps:
			st.BestCost = v.Cost
			st.BestCount = 1
			st.BestTrains = v.Trains
			st.BestCutsList = [][]int{append([]int(nil), cuts...)}
		case math.Abs(v.Cost-st.BestCost) <= eps:
			st.BestCount++
			if v.Trains < st.BestTrains {
				st.BestTrains = v.Trains
				st.BestCutsList = [][]int{append([]int(nil), cuts...)}
			} else if v.Trains == st.BestTrains {
				st.BestCutsList = append(st.BestCutsList, append([]int(nil), cuts...))
			}
		}
	}
	return st
}

// ValidateCertificate 校验切分证书：边界合法、每列可行、费用与列数重算一致。
func (p Problem) ValidateCertificate(cuts []int) (Value, error) {
	n := len(p.Cars)
	if len(cuts) < 2 || cuts[0] != 0 || cuts[len(cuts)-1] != n {
		return Value{}, fmt.Errorf("切分边界必须以 0 开始、%d 结束", n)
	}
	for k := 1; k < len(cuts); k++ {
		if cuts[k] <= cuts[k-1] {
			return Value{}, errors.New("切分边界必须严格递增")
		}
	}
	v, ok := p.splitValue(cuts)
	if !ok {
		return Value{}, errors.New("存在不可行列车（长度/重量/危险品相邻违规）")
	}
	return v, nil
}

// formatCuts 把边界转成车厢下标区间串，如 [0-2][3-3][4-7]。
func formatCuts(cuts []int) string {
	parts := make([]string, 0, len(cuts)-1)
	for s := 0; s+1 < len(cuts); s++ {
		parts = append(parts, fmt.Sprintf("[%d-%d]", cuts[s], cuts[s+1]-1))
	}
	return strings.Join(parts, "")
}
