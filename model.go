package main

import (
	"fmt"
	"math/bits"
	"sort"
)

// Problem 描述一次故障测试规划：
//   - N 个持久点，编号 0..N-1；
//   - 需求 = 每个点的单故障 + Pairs 中指定的双故障对；
//   - 每个测试用例是至多 MaxCaseSize 个点的子集（一次运行同时注入这些点的故障），
//     覆盖其中所有单点与点对，费用 = Setup + PerPoint*点数；
//   - 用例总数不得超过 MaxCases，目标为总费用最小。
type Problem struct {
	N           int
	Pairs       [][2]int
	Setup       int
	PerPoint    int
	MaxCases    int
	MaxCaseSize int
}

func (p *Problem) NumReqs() int { return p.N + len(p.Pairs) }

// CaseCost 返回一个覆盖 size 个点的用例的费用。
func (p *Problem) CaseCost(size int) int { return p.Setup + p.PerPoint*size }

// reqCov 计算点集合 mask 覆盖的需求位集：
// 位 0..N-1 为单点需求，位 N+i 为第 i 个双故障对。
func (p *Problem) reqCov(mask uint64) bitset {
	cov := newBitset(p.NumReqs())
	for i := 0; i < p.N; i++ {
		if mask>>uint(i)&1 == 1 {
			cov.Set(i)
		}
	}
	for pi, pr := range p.Pairs {
		if mask>>uint(pr[0])&1 == 1 && mask>>uint(pr[1])&1 == 1 {
			cov.Set(p.N + pi)
		}
	}
	return cov
}

// Candidate 是一个可选测试用例。
type Candidate struct {
	Mask uint64 // 点集合
	Size int
	Cost int
	Cov  bitset // 覆盖的需求
}

// Candidates 枚举所有满足容量限制的非空点子集。
func (p *Problem) Candidates() []Candidate {
	var out []Candidate
	lim := uint64(1) << uint(p.N)
	for m := uint64(1); m < lim; m++ {
		sz := bits.OnesCount64(m)
		if sz > p.MaxCaseSize {
			continue
		}
		out = append(out, Candidate{Mask: m, Size: sz, Cost: p.CaseCost(sz), Cov: p.reqCov(m)})
	}
	return out
}

// FullCover 返回全部需求置位的位集。
func (p *Problem) FullCover() bitset {
	full := newBitset(p.NumReqs())
	for i := 0; i < p.NumReqs(); i++ {
		full.Set(i)
	}
	return full
}

// Validate 校验用例方案：容量、用例数上限、需求全覆盖，并返回总费用。
// uncovered 返回未覆盖的需求下标（单点为 0..N-1，双故障对为 N+i）。
func (p *Problem) Validate(cases []uint64) (cost int, uncovered []int, err error) {
	if len(cases) > p.MaxCases {
		return 0, nil, fmt.Errorf("用例数 %d 超过上限 %d", len(cases), p.MaxCases)
	}
	cov := newBitset(p.NumReqs())
	for _, m := range cases {
		sz := bits.OnesCount64(m)
		if sz == 0 || sz > p.MaxCaseSize {
			return 0, nil, fmt.Errorf("用例 %b 的点数 %d 超出容量 [1,%d]", m, sz, p.MaxCaseSize)
		}
		cost += p.CaseCost(sz)
		cov.Or(p.reqCov(m))
	}
	for i := 0; i < p.NumReqs(); i++ {
		if !cov.Test(i) {
			uncovered = append(uncovered, i)
		}
	}
	return cost, uncovered, nil
}

// AllPairs 生成全部双故障对。
func AllPairs(n int) [][2]int {
	var pairs [][2]int
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			pairs = append(pairs, [2]int{i, j})
		}
	}
	return pairs
}

// NormalizePairs 去重、排序并校验点对。
func NormalizePairs(n int, pairs [][2]int) ([][2]int, error) {
	seen := make(map[[2]int]bool)
	var out [][2]int
	for _, pr := range pairs {
		a, b := pr[0], pr[1]
		if a > b {
			a, b = b, a
		}
		if a < 0 || b >= n || a == b {
			return nil, fmt.Errorf("非法点对 %d-%d（点数 %d）", pr[0], pr[1], n)
		}
		key := [2]int{a, b}
		if !seen[key] {
			seen[key] = true
			out = append(out, key)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i][0] != out[j][0] {
			return out[i][0] < out[j][0]
		}
		return out[i][1] < out[j][1]
	})
	return out, nil
}
