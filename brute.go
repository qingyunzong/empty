package main

// bruteForce 穷举每台设备在半开窗口 [WindowStart, WindowEnd-Duration]
// 内的所有起始时刻，校验并发上限 K 后取最小总损失。
// 仅用于短时域下对 DP 求解器做正确性核验。
func bruteForce(in Instance) (int64, []int, error) {
	if err := in.validate(); err != nil {
		return 0, nil, err
	}
	occ := make([]int, len(in.Loss))
	starts := make([]int, len(in.Devices))
	var best int64 = inf
	var bestStarts []int

	var rec func(i int, cost int64)
	rec = func(i int, cost int64) {
		if cost >= best {
			return
		}
		if i == len(in.Devices) {
			best = cost
			bestStarts = append([]int(nil), starts...)
			return
		}
		d := in.Devices[i]
		for t0 := d.WindowStart; t0+d.Duration <= d.WindowEnd; t0++ {
			ok := true
			for t := t0; t < t0+d.Duration; t++ {
				if occ[t]+1 > in.K {
					ok = false
					break
				}
			}
			if !ok {
				continue
			}
			var c int64
			for t := t0; t < t0+d.Duration; t++ {
				occ[t]++
				c += in.Loss[t]
			}
			starts[i] = t0
			rec(i+1, cost+c)
			for t := t0; t < t0+d.Duration; t++ {
				occ[t]--
			}
		}
	}
	rec(0, 0)
	if bestStarts == nil {
		return 0, nil, errInfeasible
	}
	return best, bestStarts, nil
}
