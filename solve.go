package main

import (
	"fmt"
	"math"
	"strings"
)

// eps 是浮点比较的容差。
const eps = 1e-9

// Segment 是解中的一列车：车厢区间 [Start, End)（按原序连续）。
type Segment struct {
	Start  int
	End    int
	Type   TrainType
	Length float64
	Weight float64
	Cost   float64
}

// Solution 是一种完整编组方案。
type Solution struct {
	Segments []Segment
	Cost     float64
	Trains   int
}

// solver 预计算前缀和，支持 O(1) 区间查询。
type solver struct {
	p          *Problem
	n          int
	prefLen    []float64
	prefWt     []float64
	prefHaz    []int // 危险品车厢数前缀
	prefBadAdj []int // 区间内部违禁相邻对数前缀（badAdj[i]=1 表示车厢 i-1 与 i 不相容）
}

func newSolver(p *Problem) *solver {
	n := len(p.Cars)
	s := &solver{
		p:          p,
		n:          n,
		prefLen:    make([]float64, n+1),
		prefWt:     make([]float64, n+1),
		prefHaz:    make([]int, n+1),
		prefBadAdj: make([]int, n+1),
	}
	for i, c := range p.Cars {
		s.prefLen[i+1] = s.prefLen[i] + c.Length
		s.prefWt[i+1] = s.prefWt[i] + c.Weight
		if c.Hazmat != "" {
			s.prefHaz[i+1] = s.prefHaz[i] + 1
		} else {
			s.prefHaz[i+1] = s.prefHaz[i]
		}
		bad := 0
		if i > 0 && p.incompatible(p.Cars[i-1].Hazmat, c.Hazmat) {
			bad = 1
		}
		s.prefBadAdj[i+1] = s.prefBadAdj[i] + bad
	}
	return s
}

func (s *solver) segLen(j, i int) float64 { return s.prefLen[i] - s.prefLen[j] }
func (s *solver) segWt(j, i int) float64  { return s.prefWt[i] - s.prefWt[j] }

// feasible 判断区间 [j,i) 能否编成一列 t 型列车；不可行时返回原因。
func (s *solver) feasible(j, i int, t TrainType) (bool, string) {
	if t.MaxCars > 0 && i-j > t.MaxCars {
		return false, fmt.Sprintf("车厢数 %d 超过上限 %d", i-j, t.MaxCars)
	}
	if t.MaxLength > 0 && s.segLen(j, i) > t.MaxLength+eps {
		return false, fmt.Sprintf("长度 %.1f 超过上限 %.1f", s.segLen(j, i), t.MaxLength)
	}
	if t.MaxWeight > 0 && s.segWt(j, i) > t.MaxWeight+eps {
		return false, fmt.Sprintf("重量 %.1f 超过上限 %.1f", s.segWt(j, i), t.MaxWeight)
	}
	if !t.AllowHazmat && s.prefHaz[i]-s.prefHaz[j] > 0 {
		return false, "车型禁止危险品"
	}
	if bad := s.prefBadAdj[i] - s.prefBadAdj[j]; bad > 0 {
		return false, "存在危险品违禁相邻"
	}
	return true, ""
}

// cheapestType 返回区间 [j,i) 可行车型中费用最低者（费用相同取先定义者）。
func (s *solver) cheapestType(j, i int) (int, bool) {
	best := -1
	for k, t := range s.p.Types {
		ok, _ := s.feasible(j, i, t)
		if !ok {
			continue
		}
		if best < 0 || t.Cost < s.p.Types[best].Cost-eps {
			best = k
		}
	}
	return best, best >= 0
}

// dpVal 是前缀最优值：先比总费用，再比列车数。
type dpVal struct {
	cost   float64
	trains int
	ok     bool
}

func better(cand, cur dpVal) bool {
	if !cur.ok {
		return true
	}
	if cand.cost < cur.cost-eps {
		return true
	}
	if math.Abs(cand.cost-cur.cost) <= eps && cand.trains < cur.trains {
		return true
	}
	return false
}

// Solve 用动态规划求最优编组：总费用最小，并列时列车数最少。
func Solve(p *Problem) (*Solution, error) {
	s := newSolver(p)
	n := s.n
	dp := make([]dpVal, n+1)
	cut := make([]int, n+1) // 最优分段起点
	typ := make([]int, n+1) // 该段所用车型下标
	dp[0] = dpVal{0, 0, true}
	for i := 1; i <= n; i++ {
		for j := 0; j < i; j++ {
			if !dp[j].ok {
				continue
			}
			for k, t := range p.Types {
				ok, _ := s.feasible(j, i, t)
				if !ok {
					continue
				}
				cand := dpVal{dp[j].cost + t.Cost, dp[j].trains + 1, true}
				if better(cand, dp[i]) {
					dp[i] = cand
					cut[i] = j
					typ[i] = k
				}
			}
		}
	}
	if !dp[n].ok {
		return nil, fmt.Errorf("无可行编组方案")
	}
	sol := &Solution{Cost: dp[n].cost, Trains: dp[n].trains}
	for i := n; i > 0; {
		j := cut[i]
		t := p.Types[typ[i]]
		sol.Segments = append(sol.Segments, Segment{
			Start: j, End: i, Type: t,
			Length: s.segLen(j, i), Weight: s.segWt(j, i), Cost: t.Cost,
		})
		i = j
	}
	for a, b := 0, len(sol.Segments)-1; a < b; a, b = a+1, b-1 {
		sol.Segments[a], sol.Segments[b] = sol.Segments[b], sol.Segments[a]
	}
	return sol, nil
}

// String 以 "id,id|id" 形式给出切分的紧凑表示。
func (p *Problem) splitString(sol *Solution) string {
	parts := make([]string, 0, len(sol.Segments))
	for _, seg := range sol.Segments {
		ids := make([]string, 0, seg.End-seg.Start)
		for i := seg.Start; i < seg.End; i++ {
			ids = append(ids, p.Cars[i].ID)
		}
		parts = append(parts, strings.Join(ids, ","))
	}
	return strings.Join(parts, " | ")
}
