package main

import (
	"math/rand"
	"testing"
)

// verify 校验结果满足：起始时刻落在半开窗口内、并发不超过 K、
// 占用曲线与起始时刻一致、按表重算的损失等于 MinLoss。
func verify(t *testing.T, in Instance, res Result) {
	t.Helper()
	if len(res.Starts) != len(in.Devices) {
		t.Fatalf("starts length %d, want %d", len(res.Starts), len(in.Devices))
	}
	if len(res.Occupancy) != len(in.Loss) {
		t.Fatalf("occupancy length %d, want %d", len(res.Occupancy), len(in.Loss))
	}
	occ := make([]int, len(in.Loss))
	var loss int64
	for i, d := range in.Devices {
		s := res.Starts[i]
		if s < d.WindowStart || s+d.Duration > d.WindowEnd {
			t.Fatalf("device %d start %d outside half-open window [%d,%d) with duration %d",
				i, s, d.WindowStart, d.WindowEnd, d.Duration)
		}
		for tt := s; tt < s+d.Duration; tt++ {
			occ[tt]++
			loss += in.Loss[tt]
		}
	}
	for tt := range occ {
		if occ[tt] != res.Occupancy[tt] {
			t.Fatalf("occupancy[%d] = %d, recomputed %d", tt, res.Occupancy[tt], occ[tt])
		}
		if occ[tt] > in.K {
			t.Fatalf("occupancy[%d] = %d exceeds K = %d", tt, occ[tt], in.K)
		}
	}
	if loss != res.MinLoss {
		t.Fatalf("recomputed loss %d != MinLoss %d", loss, res.MinLoss)
	}
}

// 半开边界：窗口 [2,6)、时长 3 允许起始时刻 2 或 3；
// 选 3 时占用时刻 3,4,5（不含 6），损失更低。
func TestHalfOpenWindowEnd(t *testing.T) {
	in := Instance{
		Devices: []Device{{Duration: 3, WindowStart: 2, WindowEnd: 6}},
		K:       1,
		Loss:    []int64{0, 0, 10, 10, 10, 0, 0, 0},
	}
	res, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	if res.Starts[0] != 3 {
		t.Fatalf("start = %d, want 3", res.Starts[0])
	}
	if res.MinLoss != 20 {
		t.Fatalf("minLoss = %d, want 20", res.MinLoss)
	}
	want := []int{0, 0, 0, 1, 1, 1, 0, 0}
	for i := range want {
		if res.Occupancy[i] != want[i] {
			t.Fatalf("occupancy = %v, want %v", res.Occupancy, want)
		}
	}
}

// 半开边界：窗口 [2,5)、时长 3 时唯一可行起始时刻为 2，
// 区间 [2,5) 占用时刻 2,3,4，不得触及时刻 5。
func TestHalfOpenExclusiveEnd(t *testing.T) {
	in := Instance{
		Devices: []Device{{Duration: 3, WindowStart: 2, WindowEnd: 5}},
		K:       1,
		Loss:    []int64{1, 1, 1, 1, 1, 0, 0},
	}
	res, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	if res.Starts[0] != 2 || res.MinLoss != 3 {
		t.Fatalf("start = %d, minLoss = %d; want 2, 3", res.Starts[0], res.MinLoss)
	}
	if res.Occupancy[5] != 0 || res.Occupancy[4] != 1 {
		t.Fatalf("occupancy = %v, slot 5 must be free, slot 4 occupied", res.Occupancy)
	}
}

// 并发上限：K=1 时两台设备必须错开，占用曲线处处 <= 1。
func TestCapacityConstraint(t *testing.T) {
	in := Instance{
		Devices: []Device{
			{Duration: 2, WindowStart: 0, WindowEnd: 4},
			{Duration: 2, WindowStart: 0, WindowEnd: 4},
		},
		K:    1,
		Loss: []int64{1, 1, 1, 1},
	}
	res, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	verify(t, in, res)
	if res.MinLoss != 4 {
		t.Fatalf("minLoss = %d, want 4", res.MinLoss)
	}
	for tt, o := range res.Occupancy {
		if o > 1 {
			t.Fatalf("occupancy[%d] = %d exceeds K = 1", tt, o)
		}
	}
}

// 损失按占用数加权：两台同时停机时该时刻损失计两次。
func TestLossWeightedByOccupancy(t *testing.T) {
	in := Instance{
		Devices: []Device{
			{Duration: 1, WindowStart: 0, WindowEnd: 1},
			{Duration: 1, WindowStart: 0, WindowEnd: 1},
		},
		K:    2,
		Loss: []int64{5},
	}
	res, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	if res.MinLoss != 10 || res.Occupancy[0] != 2 {
		t.Fatalf("minLoss = %d, occupancy = %v; want 10, [2]", res.MinLoss, res.Occupancy)
	}
}

// 不可行：K=1 时两台时长 2 的设备挤不进窗口 [0,2)。
func TestInfeasible(t *testing.T) {
	in := Instance{
		Devices: []Device{
			{Duration: 2, WindowStart: 0, WindowEnd: 2},
			{Duration: 2, WindowStart: 0, WindowEnd: 2},
		},
		K:    1,
		Loss: []int64{1, 1},
	}
	if _, err := Solve(in); err != errInfeasible {
		t.Fatalf("err = %v, want errInfeasible", err)
	}
	if _, _, err := bruteForce(in); err != errInfeasible {
		t.Fatalf("bruteForce err = %v, want errInfeasible", err)
	}
}

// 随机短时域对拍：DP 最优值须与穷举一致，且重建方案合法。
func TestRandomizedAgainstBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	for iter := 0; iter < 300; iter++ {
		horizon := 1 + rng.Intn(8)
		n := 1 + rng.Intn(5)
		in := Instance{
			K:    1 + rng.Intn(3),
			Loss: make([]int64, horizon),
		}
		for tt := range in.Loss {
			in.Loss[tt] = int64(rng.Intn(10))
		}
		for i := 0; i < n; i++ {
			dur := 1 + rng.Intn(3)
			if dur > horizon {
				dur = horizon
			}
			ws := rng.Intn(horizon - dur + 1)
			we := ws + dur + rng.Intn(horizon-dur-ws+1)
			in.Devices = append(in.Devices, Device{
				Duration:    dur,
				WindowStart: ws,
				WindowEnd:   we,
			})
		}

		want, _, berr := bruteForce(in)
		res, serr := Solve(in)
		if berr != nil || serr != nil {
			if (berr != nil) != (serr != nil) {
				t.Fatalf("iter %d: Solve err = %v, bruteForce err = %v\ninstance: %+v",
					iter, serr, berr, in)
			}
			continue
		}
		if res.MinLoss != want {
			t.Fatalf("iter %d: Solve minLoss = %d, bruteForce = %d\ninstance: %+v",
				iter, res.MinLoss, want, in)
		}
		verify(t, in, res)
	}
}
