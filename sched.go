package main

import (
	"errors"
	"fmt"
	"math"
	"math/bits"
	"sort"
	"strconv"
	"strings"
)

// Device 需在半开窗口 [WindowStart, WindowEnd) 内安排一段
// 固定时长 Duration 的连续停机区间 [t, t+Duration)。
// 起始时刻 t 须满足 WindowStart <= t 且 t+Duration <= WindowEnd。
type Device struct {
	Duration    int `json:"duration"`
	WindowStart int `json:"windowStart"`
	WindowEnd   int `json:"windowEnd"`
}

// Instance 描述一个检修排程问题：至多 K 台设备同时停机，
// Loss[t] 为时刻 t 每台停机设备产生的单位损失，
// 时域为半开区间 [0, len(Loss))。
type Instance struct {
	Devices []Device `json:"devices"`
	K       int      `json:"k"`
	Loss    []int64  `json:"loss"`
}

// Result 为最优解：最小总损失、每台设备的起始时刻、逐时刻占用曲线。
type Result struct {
	MinLoss   int64 `json:"minLoss"`
	Starts    []int `json:"starts"`
	Occupancy []int `json:"occupancy"`
}

var errInfeasible = errors.New("no feasible schedule")

const inf = math.MaxInt64 / 4

func (in Instance) validate() error {
	if in.K < 1 {
		return fmt.Errorf("K must be >= 1, got %d", in.K)
	}
	if len(in.Devices) == 0 || len(in.Devices) > 10 {
		return fmt.Errorf("device count must be in [1,10], got %d", len(in.Devices))
	}
	horizon := len(in.Loss)
	if horizon == 0 {
		return errors.New("loss table must be non-empty")
	}
	for i, d := range in.Devices {
		if d.Duration <= 0 {
			return fmt.Errorf("device %d: duration must be positive, got %d", i, d.Duration)
		}
		if d.WindowStart < 0 || d.WindowEnd > horizon || d.WindowStart+d.Duration > d.WindowEnd {
			return fmt.Errorf("device %d: window [%d,%d) cannot fit duration %d within horizon %d",
				i, d.WindowStart, d.WindowEnd, d.Duration, horizon)
		}
	}
	return nil
}

// Solve 用带备忘录的 DP 求最小总损失。
// 状态为 (当前时刻, 已开工设备位掩码, 在修设备剩余时长多重集)，
// 每个时刻枚举本时刻新开工设备的子集（受 K 与窗口左端约束）。
func Solve(in Instance) (Result, error) {
	if err := in.validate(); err != nil {
		return Result{}, err
	}
	s := &solver{
		in:      in,
		horizon: len(in.Loss),
		memo:    map[string]int64{},
		choice:  map[string]uint32{},
	}
	full := uint32(1)<<uint(len(in.Devices)) - 1
	cost := s.dp(0, 0, nil, full)
	if cost >= inf {
		return Result{}, errInfeasible
	}

	starts := make([]int, len(in.Devices))
	occ := make([]int, s.horizon)
	t := 0
	mask := uint32(0)
	var active []int
	for !(mask == full && len(active) == 0) {
		sub := s.choice[s.key(t, mask, active)]
		for i := range in.Devices {
			if sub>>uint(i)&1 == 1 {
				starts[i] = t
			}
		}
		if t < s.horizon {
			occ[t] = len(active) + bits.OnesCount32(sub)
		}
		mask |= sub
		active = s.advance(active, sub)
		t++
	}
	return Result{MinLoss: cost, Starts: starts, Occupancy: occ}, nil
}

type solver struct {
	in      Instance
	horizon int
	memo    map[string]int64
	choice  map[string]uint32
}

func (s *solver) dp(t int, mask uint32, active []int, full uint32) int64 {
	if mask == full && len(active) == 0 {
		return 0
	}
	for i, d := range s.in.Devices {
		if mask>>uint(i)&1 == 0 && t > d.WindowEnd-d.Duration {
			return inf // 未开工设备已错过最晚开工时刻
		}
	}
	if t >= s.horizon {
		return inf
	}
	key := s.key(t, mask, active)
	if v, ok := s.memo[key]; ok {
		return v
	}
	var cand []int
	for i, d := range s.in.Devices {
		if mask>>uint(i)&1 == 0 && d.WindowStart <= t {
			cand = append(cand, i)
		}
	}
	var best int64 = inf
	var bestSub uint32
	limit := s.in.K - len(active)
	m := len(cand)
	for sub := uint32(0); sub < 1<<uint(m); sub++ {
		if bits.OnesCount32(sub) > limit {
			continue
		}
		var subMask uint32
		for j := 0; j < m; j++ {
			if sub>>uint(j)&1 == 1 {
				subMask |= 1 << uint(cand[j])
			}
		}
		next := s.advance(active, subMask)
		c := s.in.Loss[t]*int64(len(active)+bits.OnesCount32(subMask)) +
			s.dp(t+1, mask|subMask, next, full)
		if c < best {
			best, bestSub = c, subMask
		}
	}
	s.memo[key] = best
	s.choice[key] = bestSub
	return best
}

// advance 推进一个时刻：在修设备剩余时长减一（归零离修），
// 新开工设备按 Duration-1 计入；结果排序以保证状态键唯一。
func (s *solver) advance(active []int, sub uint32) []int {
	next := make([]int, 0, len(active)+bits.OnesCount32(sub))
	for _, r := range active {
		if r-1 > 0 {
			next = append(next, r-1)
		}
	}
	for i, d := range s.in.Devices {
		if sub>>uint(i)&1 == 1 && d.Duration-1 > 0 {
			next = append(next, d.Duration-1)
		}
	}
	sort.Ints(next)
	return next
}

func (s *solver) key(t int, mask uint32, active []int) string {
	var b strings.Builder
	b.WriteString(strconv.Itoa(t))
	b.WriteByte('|')
	b.WriteString(strconv.FormatUint(uint64(mask), 16))
	for _, r := range active {
		b.WriteByte(',')
		b.WriteString(strconv.Itoa(r))
	}
	return b.String()
}
