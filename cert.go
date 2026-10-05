package sched

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
)

// BuildTimelines derives the per-resource occupancy timelines (procedure
// core plus disinfection buffers) from a set of assignments. Every room
// and equipment instance gets a timeline, sorted by busy start time.
func BuildTimelines(p *Problem, assignments map[string]PlanEntry) []ResourceTimeline {
	kind := map[string]string{}
	order := []string{}
	for _, r := range p.Rooms {
		kind[r.ID] = "room"
		order = append(order, r.ID)
	}
	for _, e := range p.Equipment {
		kind[e] = "equipment"
		order = append(order, e)
	}
	byRes := map[string][]OccupiedInterval{}
	for i := range p.Requests {
		req := &p.Requests[i]
		entry, ok := assignments[req.ID]
		if !ok {
			continue
		}
		for j, st := range req.Stages {
			w := st.Windows[entry.Windows[j]]
			occ := OccupiedInterval{
				RequestID: req.ID,
				Stage:     j,
				Core:      Interval{Start: w.Start, End: w.End},
				Busy:      Interval{Start: w.Start - st.Before, End: w.End + st.After},
			}
			byRes[entry.Rooms[j]] = append(byRes[entry.Rooms[j]], occ)
			byRes[st.Equipment] = append(byRes[st.Equipment], occ)
		}
	}
	out := make([]ResourceTimeline, 0, len(order))
	for _, res := range order {
		entries := append([]OccupiedInterval{}, byRes[res]...)
		sort.Slice(entries, func(a, b int) bool {
			x, y := entries[a], entries[b]
			if x.Busy.Start != y.Busy.Start {
				return x.Busy.Start < y.Busy.Start
			}
			if x.Busy.End != y.Busy.End {
				return x.Busy.End < y.Busy.End
			}
			if x.RequestID != y.RequestID {
				return x.RequestID < y.RequestID
			}
			return x.Stage < y.Stage
		})
		out = append(out, ResourceTimeline{ResourceID: res, Kind: kind[res], Entries: entries})
	}
	return out
}

// BuildStageGaps derives the inter-stage gap certificates for every
// scheduled two-stage request, in request order.
func BuildStageGaps(p *Problem, assignments map[string]PlanEntry) []StageGapCertificate {
	var out []StageGapCertificate
	for i := range p.Requests {
		req := &p.Requests[i]
		if len(req.Stages) != 2 {
			continue
		}
		entry, ok := assignments[req.ID]
		if !ok {
			continue
		}
		w0 := req.Stages[0].Windows[entry.Windows[0]]
		w1 := req.Stages[1].Windows[entry.Windows[1]]
		out = append(out, StageGapCertificate{
			RequestID:   req.ID,
			FirstEnd:    w0.End,
			SecondStart: w1.Start,
			Gap:         w1.Start - w0.End,
			MinGap:      req.Stages[1].MinGap,
			MaxGap:      req.Stages[1].MaxGap,
		})
	}
	return out
}

// Verify independently checks a solution against the problem: placement
// validity, gap limits, immovability of locked bookings, resource
// conflicts (buffers included), reported profit, reported change count,
// and consistency of the attached certificates.
func Verify(p *Problem, sol *Solution) error {
	if sol == nil {
		return errors.New("sched: nil solution")
	}
	if err := validate(p); err != nil {
		return err
	}
	occ := map[string][]Interval{}
	profit := 0
	for id, entry := range sol.Assignments {
		req := findRequest(p, id)
		if req == nil {
			return fmt.Errorf("sched: solution assigns unknown request %q", id)
		}
		e := entry
		if err := checkEntryShape(p, req, &e); err != nil {
			return fmt.Errorf("sched: request %q: %w", id, err)
		}
		if req.Locked != nil && !entryEqual(&e, req.Locked) {
			return fmt.Errorf("sched: locked request %q was moved", id)
		}
		pl, ok := buildPlacement(req, e.Windows, e.Rooms)
		if !ok {
			return fmt.Errorf("sched: request %q violates inter-stage gap limits", id)
		}
		for _, b := range pl.blocks {
			occ[b.res] = append(occ[b.res], Interval{Start: b.start, End: b.end})
		}
		profit += req.Profit
	}
	for i := range p.Requests {
		req := &p.Requests[i]
		if req.Locked != nil {
			if _, ok := sol.Assignments[req.ID]; !ok {
				return fmt.Errorf("sched: locked request %q is not scheduled", req.ID)
			}
		}
	}
	for res, ivs := range occ {
		sort.Slice(ivs, func(a, b int) bool { return ivs[a].Start < ivs[b].Start })
		for k := 1; k < len(ivs); k++ {
			if ivs[k].Start < ivs[k-1].End {
				return fmt.Errorf("sched: resource %q double-booked in %v and %v", res, ivs[k-1], ivs[k])
			}
		}
	}
	if profit != sol.Profit {
		return fmt.Errorf("sched: reported profit %d, recomputed %d", sol.Profit, profit)
	}
	if ch := CountChanges(p, sol.Assignments); ch != sol.Changes {
		return fmt.Errorf("sched: reported changes %d, recomputed %d", sol.Changes, ch)
	}
	if tl := BuildTimelines(p, sol.Assignments); !reflect.DeepEqual(tl, sol.Timelines) {
		return errors.New("sched: timelines do not match assignments")
	}
	if gaps := BuildStageGaps(p, sol.Assignments); !reflect.DeepEqual(gaps, sol.StageGaps) {
		return errors.New("sched: stage-gap certificates do not match assignments")
	}
	return nil
}
