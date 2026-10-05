package regalloc

import "fmt"

// Verify checks an Output certificate against the problem: occupancy must
// respect capacity, reserved registers and the start-in-register rule; the
// events must be exactly the register<->memory transitions implied by the
// occupancy; and the reported cost must equal the sum of event costs.
func Verify(in *Input, out *Output) error {
	if !out.Feasible {
		return fmt.Errorf("cannot verify an infeasible result")
	}
	if err := in.Validate(); err != nil {
		return err
	}
	P := in.numPoints()
	if len(out.Occupancy) != P {
		return fmt.Errorf("occupancy has %d points, want %d", len(out.Occupancy), P)
	}
	idx := map[string]int{}
	for j, iv := range in.Intervals {
		idx[iv.ID] = j
	}
	reserved := in.reservedAt()

	// loc[j] is the register of interval j at the previous point, -1 = memory,
	// -2 = not live.
	const notLive = -2
	loc := make([]int, len(in.Intervals))
	for j := range loc {
		loc[j] = notLive
	}
	var events []Event
	for pt := 0; pt < P; pt++ {
		ps := out.Occupancy[pt]
		if ps.Point != pt {
			return fmt.Errorf("occupancy[%d].Point = %d", pt, ps.Point)
		}
		seenReg := map[int]string{}
		seenIv := map[string]bool{}
		cur := make([]int, len(in.Intervals))
		for j := range cur {
			cur[j] = notLive
		}
		for _, a := range ps.Assignment {
			j, ok := idx[a.Interval]
			if !ok {
				return fmt.Errorf("point %d: unknown interval %q", pt, a.Interval)
			}
			if seenIv[a.Interval] {
				return fmt.Errorf("point %d: interval %q assigned twice", pt, a.Interval)
			}
			seenIv[a.Interval] = true
			iv := in.Intervals[j]
			if pt < iv.Start || pt >= iv.End {
				return fmt.Errorf("point %d: interval %q is not live", pt, a.Interval)
			}
			if a.Reg >= 0 {
				if a.Reg >= in.NumRegisters {
					return fmt.Errorf("point %d: register %d out of range", pt, a.Reg)
				}
				for _, r := range reserved[pt] {
					if a.Reg == r {
						return fmt.Errorf("point %d: interval %q in reserved register %d", pt, a.Interval, r)
					}
				}
				if prev, dup := seenReg[a.Reg]; dup {
					return fmt.Errorf("point %d: register %d holds both %q and %q", pt, a.Reg, prev, a.Interval)
				}
				seenReg[a.Reg] = a.Interval
			} else if a.Reg != -1 {
				return fmt.Errorf("point %d: invalid reg value %d", pt, a.Reg)
			}
			cur[j] = a.Reg
		}
		// Every live interval must appear exactly once.
		for j, iv := range in.Intervals {
			live := iv.Start <= pt && pt < iv.End
			if live && cur[j] == notLive {
				return fmt.Errorf("point %d: live interval %q has no location", pt, iv.ID)
			}
			if !live && cur[j] != notLive {
				return fmt.Errorf("point %d: dead interval %q has a location", pt, iv.ID)
			}
			if pt == iv.Start && cur[j] < 0 {
				return fmt.Errorf("point %d: interval %q must start in a register", pt, iv.ID)
			}
			if pt == iv.End-1 && cur[j] < 0 {
				return fmt.Errorf("point %d: interval %q must be in a register at its last use", pt, iv.ID)
			}
		}
		// Derive transition events.
		for j, iv := range in.Intervals {
			if loc[j] == notLive || cur[j] == notLive {
				continue
			}
			wasMem := loc[j] == -1
			isMem := cur[j] == -1
			switch {
			case !wasMem && isMem:
				events = append(events, Event{Point: pt, Type: "store", Interval: iv.ID, Cost: iv.StoreCost})
			case wasMem && !isMem:
				events = append(events, Event{Point: pt, Type: "load", Interval: iv.ID, Cost: iv.LoadCost})
			}
		}
		loc = cur
	}

	// The reported events must match the derived ones (order-insensitive).
	if len(events) != len(out.Events) {
		return fmt.Errorf("certificate has %d events, occupancy implies %d", len(out.Events), len(events))
	}
	type key struct {
		Point int
		Type  string
		ID    string
	}
	count := map[key]int64{}
	for _, e := range events {
		count[key{e.Point, e.Type, e.Interval}]++
	}
	var total int64
	for _, e := range out.Events {
		k := key{e.Point, e.Type, e.Interval}
		if count[k] == 0 {
			return fmt.Errorf("unexpected event %+v", e)
		}
		count[k]--
		j := idx[e.Interval]
		want := in.Intervals[j].LoadCost
		if e.Type == "store" {
			want = in.Intervals[j].StoreCost
		} else if e.Type != "load" {
			return fmt.Errorf("unknown event type %q", e.Type)
		}
		if e.Cost != want {
			return fmt.Errorf("event %+v: cost %d, want %d", e, e.Cost, want)
		}
		total += e.Cost
	}
	if total != out.Cost {
		return fmt.Errorf("reported cost %d, events sum to %d", out.Cost, total)
	}
	return nil
}
