package main

import "fmt"

// Verify independently replays a certificate against the instance and
// checks feasibility, that declared events match the occupancy
// transitions, and that the declared total cost is exact.
func Verify(in *Input, sol *Solution) error {
	if err := validate(in); err != nil {
		return err
	}
	inst := buildInstance(in)
	if len(sol.Points) != inst.numPoints {
		return fmt.Errorf("certificate has %d points, want %d", len(sol.Points), inst.numPoints)
	}
	regIndex := map[string]int{}
	for i, r := range in.Registers {
		regIndex[r] = i
	}
	ivIndex := map[string]int{}
	for i, iv := range in.Intervals {
		ivIndex[iv.Name] = i
	}

	// state[i][p] = true iff interval i is register-resident at point p.
	state := make([][]bool, len(in.Intervals))
	for i := range state {
		state[i] = make([]bool, inst.numPoints)
	}

	for p, ps := range sol.Points {
		if ps.Point != p {
			return fmt.Errorf("point %d: certificate out of order", p)
		}
		// Reserved registers must be reported and unused.
		wantReserved := map[string]bool{}
		for _, r := range inst.reservedNames[p] {
			wantReserved[r] = true
		}
		if len(ps.Reserved) != len(wantReserved) {
			return fmt.Errorf("point %d: reserved set mismatch", p)
		}
		for _, r := range ps.Reserved {
			if !wantReserved[r] {
				return fmt.Errorf("point %d: unexpected reserved register %q", p, r)
			}
		}
		avail := map[string]bool{}
		for _, r := range inst.avail[p] {
			avail[in.Registers[r]] = true
		}
		seenIv := map[string]bool{}
		for reg, ivName := range ps.Occupancy {
			if !avail[reg] {
				return fmt.Errorf("point %d: register %q not available (reserved or unknown)", p, reg)
			}
			i, ok := ivIndex[ivName]
			if !ok {
				return fmt.Errorf("point %d: unknown interval %q", p, ivName)
			}
			if !(in.Intervals[i].Start <= p && p < in.Intervals[i].End) {
				return fmt.Errorf("point %d: interval %q not live", p, ivName)
			}
			if seenIv[ivName] {
				return fmt.Errorf("point %d: interval %q in two registers", p, ivName)
			}
			seenIv[ivName] = true
			state[i][p] = true
		}
		// Every live interval is either in a register or listed spilled.
		spilled := map[string]bool{}
		for _, n := range ps.Spilled {
			spilled[n] = true
		}
		for _, i := range inst.live[p] {
			n := in.Intervals[i].Name
			inReg := seenIv[n]
			inSpill := spilled[n]
			if inReg == inSpill {
				return fmt.Errorf("point %d: interval %q must be exactly one of resident/spilled", p, n)
			}
		}
		if len(ps.Spilled) != len(inst.live[p])-len(ps.Occupancy) {
			return fmt.Errorf("point %d: spilled list has extra entries", p)
		}
	}

	// Recompute events from the occupancy and compare with declared ones.
	var want []Event
	for i, iv := range in.Intervals {
		prevInReg := false
		for p := iv.Start; p < iv.End; p++ {
			inReg := state[i][p]
			switch {
			case p == iv.Start && !inReg:
				want = append(want, Event{p, iv.Name, "store", iv.StoreCost})
			case p > iv.Start && inReg && !prevInReg:
				want = append(want, Event{p, iv.Name, "load", iv.LoadCost})
			case p > iv.Start && !inReg && prevInReg:
				want = append(want, Event{p, iv.Name, "store", iv.StoreCost})
			}
			prevInReg = inReg
		}
	}
	key := func(e Event) string { return fmt.Sprintf("%d/%s/%s/%d", e.Point, e.Interval, e.Op, e.Cost) }
	declared := map[string]int{}
	for _, e := range sol.Events {
		declared[key(e)]++
	}
	for _, e := range want {
		k := key(e)
		if declared[k] == 0 {
			return fmt.Errorf("missing event %+v", e)
		}
		declared[k]--
	}
	for k, n := range declared {
		if n > 0 {
			return fmt.Errorf("unexpected event %s", k)
		}
	}

	total := 0
	for _, e := range want {
		total += e.Cost
	}
	if total != sol.TotalCost {
		return fmt.Errorf("declared total cost %d, recomputed %d", sol.TotalCost, total)
	}
	return nil
}
