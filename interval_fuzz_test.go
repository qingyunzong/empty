package dataeng

import (
	"math"
	"math/rand/v2"
	"testing"
)

// TestRandomizedDifferential 以随机区间对两种缺口算法做全比较，
// 并核验“覆盖并集 + 缺口 == 子区间”的联合覆盖不变式。
func TestRandomizedDifferential(t *testing.T) {
	extremes := []int64{math.MinInt64, math.MinInt64 + 1, -100, -1, 0, 1, 100, math.MaxInt64 - 1, math.MaxInt64}
	pick := func(r *rand.Rand) int64 {
		if r.IntN(3) == 0 {
			return extremes[r.IntN(len(extremes))]
		}
		return r.Int64N(400) - 200
	}
	for iter := 0; iter < 2000; iter++ {
		r := rand.New(rand.NewPCG(uint64(iter), 42))
		var child Interval
		for !child.valid() || child.empty() {
			child = Interval{pick(r), pick(r)}
		}
		n := r.IntN(6)
		parents := make([]Interval, 0, n)
		for i := 0; i < n; i++ {
			a, b := pick(r), pick(r)
			if a <= b {
				parents = append(parents, Interval{a, b})
			}
		}
		merged := unionIntervals(parents)
		gotSweep := sweepGaps(child, merged)
		gotDisc := discreteGaps(child, parents)
		if !intervalsEqual(gotSweep, gotDisc) {
			t.Fatalf("iter %d: sweep %v != discrete %v (child=%v parents=%v)",
				iter, gotSweep, gotDisc, child, parents)
		}
		// 极值与联合覆盖不变式。
		if err := verifyExtrema(child, parents, gotSweep); err != nil {
			t.Fatalf("iter %d: %v (child=%v parents=%v gaps=%v)",
				iter, err, child, parents, gotSweep)
		}
		// 缺口必须落在子区间内部且彼此最大、不相交。
		for i, g := range gotSweep {
			if g.Start < child.Start || g.End > child.End {
				t.Fatalf("iter %d: gap escapes child", iter)
			}
			if i > 0 && g.Start <= gotSweep[i-1].End {
				t.Fatalf("iter %d: gaps not maximal", iter)
			}
			for _, p := range merged {
				if p.Start < g.End && g.Start < p.End {
					t.Fatalf("iter %d: gap %v overlaps parent %v", iter, g, p)
				}
			}
		}
	}
}

func TestDiffIntervals(t *testing.T) {
	cases := []struct {
		name                string
		after, before, want []Interval
	}{
		{"all new", []Interval{{0, 10}}, nil, []Interval{{0, 10}}},
		{"no change", []Interval{{0, 10}}, []Interval{{0, 10}}, nil},
		{"extend", []Interval{{0, 20}}, []Interval{{0, 10}}, []Interval{{10, 20}}},
		{"split", []Interval{{0, 5}, {10, 15}}, []Interval{{0, 15}}, nil},
		{"mixed", []Interval{{0, 10}, {20, 30}}, []Interval{{5, 25}},
			[]Interval{{0, 5}, {25, 30}}},
		{"touching", []Interval{{0, 5}, {5, 10}}, nil, []Interval{{0, 10}}},
	}
	for _, tc := range cases {
		got := diffIntervals(tc.after, tc.before)
		if !intervalsEqual(got, tc.want) {
			t.Fatalf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}
