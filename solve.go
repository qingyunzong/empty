package regalloc

import (
	"math"
	"math/bits"
	"sort"
	"strings"
)

// Solve finds a minimum-cost allocation.
//
// Model: an interval must occupy a register at its definition point (Start)
// and at its last use (End-1); at every other point it may live in a
// register or in memory. Because register-to-register moves are free, the
// cost of a solution only depends on, at every point, the set of live
// intervals kept in memory (the spill set). Register identity only matters
// for feasibility: the intervals kept in registers must fit into the
// registers not reserved at that point. The DP therefore runs over spill
// sets, and a concrete register assignment is recovered afterwards.
func Solve(in *Input) (*Output, error) {
	if err := in.Validate(); err != nil {
		return nil, err
	}
	n := len(in.Intervals)
	P := in.numPoints()
	reserved := in.reservedAt()

	// Compress the timeline to event points: interval starts, interval
	// ends and call points. Between consecutive event points the live set
	// and the reserved set are constant, and since costs are non-negative
	// an optimal solution never changes its spill set inside such a gap.
	eventSet := map[int]bool{}
	for _, iv := range in.Intervals {
		eventSet[iv.Start] = true
		eventSet[iv.End] = true
		eventSet[iv.End-1] = true
	}
	for pt := range reserved {
		if pt < P {
			eventSet[pt] = true
		}
	}
	coords := make([]int, 0, len(eventSet))
	for c := range eventSet {
		coords = append(coords, c)
	}
	sort.Ints(coords)
	T := len(coords)

	live := make([]uint32, T)    // intervals live at the event point
	mustReg := make([]uint32, T) // intervals that must be in a register
	avail := make([]int, T)      // usable registers at the event point
	for i, c := range coords {
		avail[i] = in.NumRegisters - len(reserved[c])
		for j, iv := range in.Intervals {
			if iv.Start <= c && c < iv.End {
				live[i] |= 1 << uint(j)
			}
			if iv.Start == c {
				mustReg[i] |= 1 << uint(j)
			}
			if iv.End-1 == c {
				mustReg[i] |= 1 << uint(j)
			}
		}
	}

	// Feasibility: intervals that must be in a register at a point have to
	// fit; everything else can be spilled.
	for i, c := range coords {
		if bits.OnesCount32(mustReg[i]) > avail[i] {
			return &Output{
				Feasible: false,
				Reason:   infeasibleReason(in, c),
			}, nil
		}
	}

	// Valid spill sets per event point: subsets S of live with
	// |live| - |S| <= avail and no must-be-in-register interval spilled.
	states := make([][]uint32, T)
	for i := range coords {
		sub := live[i]
		for {
			if sub&mustReg[i] == 0 && bits.OnesCount32(live[i])-bits.OnesCount32(sub) <= avail[i] {
				states[i] = append(states[i], sub)
			}
			if sub == 0 {
				break
			}
			sub = (sub - 1) & live[i]
		}
	}

	// Per-interval cost sums indexed by bitmask.
	size := 1 << uint(n)
	loadSum := make([]int64, size)
	storeSum := make([]int64, size)
	for m := 1; m < size; m++ {
		b := m & -m
		j := bits.TrailingZeros32(uint32(b))
		loadSum[m] = loadSum[m^b] + in.Intervals[j].LoadCost
		storeSum[m] = storeSum[m^b] + in.Intervals[j].StoreCost
	}

	const inf = math.MaxInt64 / 4
	dp := make([]int64, size)
	for i := range dp {
		dp[i] = inf
	}
	for _, s := range states[0] {
		dp[s] = 0
	}
	// parent[t][state] = best previous state (0xFFFF = none).
	parent := make([][]uint16, T)
	for i := range parent {
		parent[i] = make([]uint16, size)
		for j := range parent[i] {
			parent[i][j] = 0xFFFF
		}
	}

	g := make([]int64, size) // scratch: dp[s] + loadSum[s & cont]
	for t := 1; t < T; t++ {
		cont := live[t-1] & live[t]
		next := make([]int64, size)
		for i := range next {
			next[i] = inf
		}
		for _, s := range states[t-1] {
			if dp[s] >= inf {
				g[s] = inf
			} else {
				g[s] = dp[s] + loadSum[s&cont]
			}
		}
		for _, ns := range states[t] {
			best := int64(inf)
			var bestPrev uint16 = 0xFFFF
			sc := storeSum[ns&cont]
			for _, s := range states[t-1] {
				// Transition cost = store(ns&cont) + load(s&cont)
				//   - (load+store)(s&ns); see package docs.
				v := g[s] - loadSum[s&ns] - storeSum[s&ns]
				if v < best {
					best = v
					bestPrev = uint16(s)
				}
			}
			if bestPrev != 0xFFFF {
				next[ns] = best + sc
				parent[t][ns] = bestPrev
			}
		}
		dp = next
	}

	// Best final state.
	bestCost := int64(inf)
	var cur uint16 = 0xFFFF
	for _, s := range states[T-1] {
		if dp[s] < bestCost {
			bestCost = dp[s]
			cur = uint16(s)
		}
	}
	if cur == 0xFFFF {
		return &Output{Feasible: false, Reason: "no valid allocation"}, nil
	}

	// Recover spill sets per event point.
	spill := make([]uint32, T)
	spill[T-1] = uint32(cur)
	for t := T - 1; t >= 1; t-- {
		cur = parent[t][cur]
		spill[t-1] = uint32(cur)
	}

	out := &Output{Feasible: true, Cost: bestCost}
	out.Occupancy = buildOccupancy(in, coords, P, live, avail, reserved, spill)
	out.Events = buildEvents(in, coords, live, spill)
	out.Verified = Verify(in, out) == nil
	return out, nil
}

func infeasibleReason(in *Input, point int) string {
	names := []string{}
	for _, iv := range in.Intervals {
		if iv.Start == point {
			names = append(names, iv.ID)
		}
	}
	return "point " + itoa(point) + ": intervals starting here (" +
		strings.Join(names, ", ") + ") do not fit in the available registers"
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	buf := [20]byte{}
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// buildOccupancy expands the compressed solution to every program point and
// assigns concrete registers. Intervals keep their register across points
// when possible; free lowest-numbered available registers are used first.
func buildOccupancy(in *Input, coords []int, P int, live []uint32, avail []int, reserved map[int][]int, spill []uint32) []PointState {
	n := len(in.Intervals)
	out := make([]PointState, 0, P)
	// Leading points before the first event have no live intervals.
	for pt := 0; pt < coords[0] && pt < P; pt++ {
		out = append(out, PointState{Point: pt})
	}
	regOf := make([]int, n) // register held at previous event point, -1 = none
	for j := range regOf {
		regOf[j] = -1
	}
	for t, c := range coords {
		next := P
		if t+1 < len(coords) {
			next = coords[t+1]
		}
		// Assign registers for this segment.
		used := make([]bool, in.NumRegisters)
		for _, r := range reserved[c] {
			used[r] = true
		}
		assign := make([]int, n)
		for j := range assign {
			assign[j] = -1
		}
		// First pass: keep previous registers.
		for j := 0; j < n; j++ {
			if live[t]&(1<<uint(j)) == 0 || spill[t]&(1<<uint(j)) != 0 {
				continue
			}
			if r := regOf[j]; r >= 0 && !used[r] {
				assign[j] = r
				used[r] = true
			}
		}
		// Second pass: lowest free register.
		for j := 0; j < n; j++ {
			if live[t]&(1<<uint(j)) == 0 || spill[t]&(1<<uint(j)) != 0 || assign[j] >= 0 {
				continue
			}
			for r := 0; r < in.NumRegisters; r++ {
				if !used[r] {
					assign[j] = r
					used[r] = true
					break
				}
			}
		}
		copy(regOf, assign)
		res := reserved[c]
		for pt := c; pt < next; pt++ {
			ps := PointState{Point: pt, Reserved: res}
			for j := 0; j < n; j++ {
				if live[t]&(1<<uint(j)) == 0 {
					continue
				}
				ps.Assignment = append(ps.Assignment, RegAssignment{
					Interval: in.Intervals[j].ID,
					Reg:      assign[j],
				})
			}
			out = append(out, ps)
		}
	}
	return out
}

// buildEvents derives the store/load certificate from consecutive spill
// sets. A transition happens at the coordinate of the later event point.
func buildEvents(in *Input, coords []int, live, spill []uint32) []Event {
	n := len(in.Intervals)
	events := []Event{}
	for t := 1; t < len(coords); t++ {
		cont := live[t-1] & live[t]
		for j := 0; j < n; j++ {
			bit := uint32(1) << uint(j)
			if cont&bit == 0 {
				continue
			}
			wasMem := spill[t-1]&bit != 0
			isMem := spill[t]&bit != 0
			switch {
			case !wasMem && isMem:
				events = append(events, Event{
					Point:    coords[t],
					Type:     "store",
					Interval: in.Intervals[j].ID,
					Cost:     in.Intervals[j].StoreCost,
				})
			case wasMem && !isMem:
				events = append(events, Event{
					Point:    coords[t],
					Type:     "load",
					Interval: in.Intervals[j].ID,
					Cost:     in.Intervals[j].LoadCost,
				})
			}
		}
	}
	return events
}
