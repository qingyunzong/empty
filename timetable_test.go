package timetable

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func TestWaitTime(t *testing.T) {
	cases := []struct {
		period, arr, dep, want int
	}{
		{10, 3, 3, 0}, // 同刻可换乘，等待为 0
		{10, 3, 7, 4},
		{10, 9, 1, 2}, // 跨周期回绕
		{10, 0, 9, 9},
		{10, 9, 0, 1},
	}
	for _, c := range cases {
		if got := WaitTime(c.period, c.arr, c.dep); got != c.want {
			t.Errorf("WaitTime(%d,%d,%d)=%d, want %d", c.period, c.arr, c.dep, got, c.want)
		}
	}
}

func TestSameTimeTransferAllowed(t *testing.T) {
	// 两线同刻到达换乘站：等待 0，阈值 0 也不计罚。
	p := Problem{
		Period:  10,
		Domains: [][]int{{0, 5}, {0, 5}},
		Transfers: []Transfer{
			{From: 0, To: 1, FromTravel: 3, ToTravel: 3, Threshold: 0},
		},
	}
	offsets, pen, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if pen != 0 {
		t.Fatalf("penalty=%d, want 0 (same-time transfer must be allowed)", pen)
	}
	got, err := Evaluate(p, offsets)
	if err != nil {
		t.Fatal(err)
	}
	if got != pen {
		t.Fatalf("Evaluate=%d, Solve penalty=%d", got, pen)
	}
}

func TestPenaltyWhenWaitExceedsThreshold(t *testing.T) {
	// 线0到站时刻=offset0，线1离站时刻=offset1；等待=(offset1-offset0) mod 10。
	// 阈值 2：只有 offset1-offset0 ∈ {0,1,2} 免罚，域内无法满足，最小罚 1。
	p := Problem{
		Period:  10,
		Domains: [][]int{{0}, {5}},
		Transfers: []Transfer{
			{From: 0, To: 1, Threshold: 2},
		},
	}
	_, pen, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if pen != 1 {
		t.Fatalf("penalty=%d, want 1", pen)
	}
}

func TestWeightAndDefaultWeight(t *testing.T) {
	p := Problem{
		Period:  10,
		Domains: [][]int{{0}, {5}, {6}},
		Transfers: []Transfer{
			{From: 0, To: 1, Threshold: 2, Weight: 7}, // 等待 5 > 2，罚 7
			{From: 0, To: 2, Threshold: 2},            // 等待 6 > 2，Weight 缺省按 1
		},
	}
	pen, err := Evaluate(p, []int{0, 5, 6})
	if err != nil {
		t.Fatal(err)
	}
	if pen != 8 {
		t.Fatalf("penalty=%d, want 8", pen)
	}
}

func TestLexicographicTieBreak(t *testing.T) {
	// 无换乘对时罚分恒为 0，应返回字典序最小偏移向量。
	p := Problem{
		Period:  10,
		Domains: [][]int{{4, 2, 9}, {7, 1}},
	}
	offsets, pen, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if pen != 0 {
		t.Fatalf("penalty=%d, want 0", pen)
	}
	if want := []int{2, 1}; !reflect.DeepEqual(offsets, want) {
		t.Fatalf("offsets=%v, want lexicographically smallest %v", offsets, want)
	}
}

func TestLexicographicTieBreakWithPenalty(t *testing.T) {
	// 换乘对 (0->1) 阈值 0：offset1==offset0 时免罚。
	// 两线域交集为 {3,5}，字典序最小免罚向量为 {3,3}。
	p := Problem{
		Period:  10,
		Domains: [][]int{{5, 3, 8}, {3, 5, 9}},
		Transfers: []Transfer{
			{From: 0, To: 1, Threshold: 0},
		},
	}
	offsets, pen, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if pen != 0 {
		t.Fatalf("penalty=%d, want 0", pen)
	}
	if want := []int{3, 3}; !reflect.DeepEqual(offsets, want) {
		t.Fatalf("offsets=%v, want %v", offsets, want)
	}
}

func TestSolveMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	for trial := 0; trial < 300; trial++ {
		period := 1 + rng.Intn(12)
		nLines := 1 + rng.Intn(5)
		domains := make([][]int, nLines)
		for i := range domains {
			size := 1 + rng.Intn(6)
			d := make([]int, size)
			for j := range d {
				d[j] = rng.Intn(period)
			}
			domains[i] = d
		}
		nTransfers := rng.Intn(7)
		transfers := make([]Transfer, nTransfers)
		for i := range transfers {
			transfers[i] = Transfer{
				From:       rng.Intn(nLines),
				To:         rng.Intn(nLines),
				FromTravel: rng.Intn(period),
				ToTravel:   rng.Intn(period),
				Threshold:  rng.Intn(period),
				Weight:     rng.Intn(4), // 含 0，检验缺省权重
			}
		}
		p := Problem{Period: period, Domains: domains, Transfers: transfers}

		gotOff, gotPen, err := Solve(p)
		if err != nil {
			t.Fatalf("trial %d: Solve: %v", trial, err)
		}
		wantOff, wantPen, err := SolveBruteForce(p)
		if err != nil {
			t.Fatalf("trial %d: SolveBruteForce: %v", trial, err)
		}
		if gotPen != wantPen || !reflect.DeepEqual(gotOff, wantOff) {
			t.Fatalf("trial %d: Solve=(%v,%d), brute=(%v,%d)\nproblem=%+v",
				trial, gotOff, gotPen, wantOff, wantPen, p)
		}
		// 抽查 Evaluate 与求解器罚分一致。
		ev, err := Evaluate(p, gotOff)
		if err != nil {
			t.Fatalf("trial %d: Evaluate: %v", trial, err)
		}
		if ev != gotPen {
			t.Fatalf("trial %d: Evaluate=%d, Solve penalty=%d", trial, ev, gotPen)
		}
	}
}

func TestSolveMaxScale(t *testing.T) {
	// 上界规模：8 条线路、每域 12 个取值、20 个换乘对，分支限界应快速完成。
	rng := rand.New(rand.NewSource(7))
	period := 60
	domains := make([][]int, MaxLines)
	for i := range domains {
		d := make([]int, MaxDomain)
		for j := range d {
			d[j] = rng.Intn(period)
		}
		domains[i] = d
	}
	transfers := make([]Transfer, 20)
	for i := range transfers {
		transfers[i] = Transfer{
			From:       rng.Intn(MaxLines),
			To:         rng.Intn(MaxLines),
			FromTravel: rng.Intn(period),
			ToTravel:   rng.Intn(period),
			Threshold:  rng.Intn(20),
			Weight:     1 + rng.Intn(3),
		}
	}
	p := Problem{Period: period, Domains: domains, Transfers: transfers}
	offsets, pen, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	ev, err := Evaluate(p, offsets)
	if err != nil {
		t.Fatal(err)
	}
	if ev != pen {
		t.Fatalf("Evaluate=%d, Solve penalty=%d", ev, pen)
	}
}

func TestValidate(t *testing.T) {
	good := Problem{Period: 10, Domains: [][]int{{0}}}
	if err := good.Validate(); err != nil {
		t.Fatalf("good problem rejected: %v", err)
	}
	bad := []Problem{
		{Period: 0, Domains: [][]int{{0}}},                                                          // 周期非正
		{Period: 10},                                                                                // 无线路
		{Period: 10, Domains: make([][]int, MaxLines+1)},                                            // 线路超上限
		{Period: 10, Domains: [][]int{{}}},                                                          // 空域
		{Period: 10, Domains: [][]int{make([]int, MaxDomain+1)}},                                    // 域超上限（值越界先触发亦无妨）
		{Period: 10, Domains: [][]int{{10}}},                                                        // 偏移越界
		{Period: 10, Domains: [][]int{{-1}}},                                                        // 偏移为负
		{Period: 10, Domains: [][]int{{0}}, Transfers: []Transfer{{From: 0, To: 1}}},                // 换乘引用未知线路
		{Period: 10, Domains: [][]int{{0}}, Transfers: []Transfer{{From: 0, To: 0, Threshold: -1}}}, // 负阈值
	}
	for i, p := range bad {
		if err := p.Validate(); err == nil {
			t.Errorf("bad problem %d accepted", i)
		}
		if _, _, err := Solve(p); err == nil {
			t.Errorf("Solve accepted bad problem %d", i)
		}
	}
}

func ExampleSolve() {
	// 周期 60 分钟，三条线路；换乘对：0->1 阈值 5，1->2 阈值 8。
	p := Problem{
		Period:  60,
		Domains: [][]int{{0, 10, 20}, {5, 15, 25}, {0, 30}},
		Transfers: []Transfer{
			{From: 0, To: 1, Threshold: 5},
			{From: 1, To: 2, Threshold: 8},
		},
	}
	// 选 {0,5,30}：0->1 等待 5（免罚），1->2 等待 25（罚 1），合计 1；
	// 选 {20,25,30}：等待 5、5 均免罚，合计 0，且为字典序最小免罚向量。
	offsets, penalty, _ := Solve(p)
	fmt.Println(offsets, penalty)
	// Output:
	// [20 25 30] 0
}
