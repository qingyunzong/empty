package main

// 模型约定：
//   - 时域为整数时刻 0..T-1，T = len(Loss)。
//   - 设备 i 停机占用半开区间 [s, s+Dur)，即占用时刻 s .. s+Dur-1。
//   - 允许窗 [Start, End) 为半开：起始时刻 s 须满足 Start <= s 且 s+Dur <= End。
//   - 任意时刻同时停机的设备数 <= K。
//   - 总损失 = sum_t Loss[t] * occ(t)，occ(t) 为时刻 t 的停机台数。

const maxDevices = 10

type Device struct {
	Dur   int `json:"dur"`   // 固定停机时长（占用 Dur 个连续时刻）
	Start int `json:"start"` // 允许窗左端（含）
	End   int `json:"end"`   // 允许窗右端（不含），须满足 s+Dur <= End
}

type Problem struct {
	K       int      `json:"k"`
	Loss    []int    `json:"loss"`
	Devices []Device `json:"devices"`
}

// state：进入时刻 t 时的压缩状态。
// started 的第 i 位表示设备 i 是否已开始停机；
// rem[i] 表示设备 i 自当前时刻起还需占用的时刻数（0 表示未在停机）。
type state struct {
	started uint16
	rem     [maxDevices]uint8
}

type parent struct {
	prev  state
	added uint16 // 在时刻 t 新启动停机的设备集合
}

// Solve 用按时刻推进的 DP 求最小总损失。
// 返回 ok=false 表示输入非法或无可行调度。
func Solve(p Problem) (ok bool, cost int, starts []int, occ []int) {
	n := len(p.Devices)
	T := len(p.Loss)
	if n > maxDevices || p.K < 0 {
		return false, 0, nil, nil
	}
	for _, d := range p.Devices {
		if d.Dur < 1 || d.Start < 0 || d.Start+d.Dur > d.End || d.End > T {
			return false, 0, nil, nil
		}
	}
	full := uint16(1<<uint(n)) - 1

	cur := map[state]int{{}: 0}
	parents := make([]map[state]parent, 0, T)

	for t := 0; t < T; t++ {
		next := make(map[state]int)
		par := make(map[state]parent)

		// 时刻 t 允许启动的设备
		var avail []int
		for i := 0; i < n; i++ {
			d := p.Devices[i]
			if t >= d.Start && t+d.Dur <= d.End {
				avail = append(avail, i)
			}
		}

		for st, c := range cur {
			occNow := 0
			for i := 0; i < n; i++ {
				if st.rem[i] > 0 {
					occNow++
				}
			}
			// 枚举 avail 中未启动设备的子集 S，要求 occNow+|S| <= K
			var rec func(idx int, added uint16, cnt int)
			rec = func(idx int, added uint16, cnt int) {
				if idx == len(avail) {
					ns := state{started: st.started | added}
					for i := 0; i < n; i++ {
						if st.rem[i] > 0 {
							ns.rem[i] = st.rem[i] - 1
						}
					}
					for i := 0; i < n; i++ {
						if added>>uint(i)&1 == 1 {
							ns.rem[i] = uint8(p.Devices[i].Dur - 1)
						}
					}
					nc := c + p.Loss[t]*(occNow+cnt)
					if old, seen := next[ns]; !seen || nc < old {
						next[ns] = nc
						par[ns] = parent{prev: st, added: added}
					}
					return
				}
				i := avail[idx]
				rec(idx+1, added, cnt) // 不启动 i
				if st.started>>uint(i)&1 == 0 && occNow+cnt+1 <= p.K {
					rec(idx+1, added|1<<uint(i), cnt+1) // 启动 i
				}
			}
			rec(0, 0, 0)
		}
		parents = append(parents, par)
		cur = next
	}

	best := -1
	var bestState state
	for st, c := range cur {
		if st.started != full {
			continue
		}
		done := true
		for i := 0; i < n; i++ {
			if st.rem[i] != 0 {
				done = false
				break
			}
		}
		if !done {
			continue
		}
		if best < 0 || c < best {
			best, bestState = c, st
		}
	}
	if best < 0 {
		return false, 0, nil, nil
	}

	starts = make([]int, n)
	st := bestState
	for t := T - 1; t >= 0; t-- {
		pr := parents[t][st]
		for i := 0; i < n; i++ {
			if pr.added>>uint(i)&1 == 1 {
				starts[i] = t
			}
		}
		st = pr.prev
	}
	occ = Occupancy(p, starts)
	return true, best, starts, occ
}

// Occupancy 由起始时刻计算占用曲线（每台设备占用半开区间 [s, s+Dur)）。
func Occupancy(p Problem, starts []int) []int {
	occ := make([]int, len(p.Loss))
	for i, s := range starts {
		for t := s; t < s+p.Devices[i].Dur; t++ {
			occ[t]++
		}
	}
	return occ
}

// Brute 穷举所有设备的可行起始时刻组合，用于短时域核验。
func Brute(p Problem) (ok bool, cost int, starts []int) {
	n := len(p.Devices)
	T := len(p.Loss)
	occArr := make([]int, T)
	curStarts := make([]int, n)
	bestStarts := make([]int, n)
	best := -1

	var rec func(i int)
	rec = func(i int) {
		if i == n {
			c := 0
			for t := 0; t < T; t++ {
				c += p.Loss[t] * occArr[t]
			}
			if best < 0 || c < best {
				best = c
				copy(bestStarts, curStarts)
			}
			return
		}
		d := p.Devices[i]
		for s := d.Start; s+d.Dur <= d.End; s++ {
			fit := true
			for t := s; t < s+d.Dur; t++ {
				if occArr[t]+1 > p.K {
					fit = false
					break
				}
			}
			if !fit {
				continue
			}
			for t := s; t < s+d.Dur; t++ {
				occArr[t]++
			}
			curStarts[i] = s
			rec(i + 1)
			for t := s; t < s+d.Dur; t++ {
				occArr[t]--
			}
		}
	}
	rec(0)
	if best < 0 {
		return false, 0, nil
	}
	return true, best, bestStarts
}
