package planner

import (
	"fmt"
	"sort"
	"strings"
)

// Certificate renders a human-checkable certificate for a plan: a timeline
// per resource (rooms and equipment) including disinfection buffers, and an
// inter-stage gap statement for every two-stage request.
func Certificate(p *Problem, plan *Plan) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "profit=%d changes=%d\n", plan.Profit, plan.Changes)

	all := append(append([]Booking(nil), p.Existing...), plan.Bookings...)
	byRes := map[string][]Booking{}
	resType := map[string]string{}
	for _, b := range all {
		byRes[b.Room] = append(byRes[b.Room], b)
		byRes[b.Equipment] = append(byRes[b.Equipment], b)
	}
	for name, typ := range p.Rooms {
		resType[name] = "room(" + typ + ")"
	}
	for _, b := range all {
		if _, ok := resType[b.Equipment]; !ok {
			resType[b.Equipment] = "equipment"
		}
	}

	var resources []string
	for r := range resType {
		resources = append(resources, r)
	}
	sort.Strings(resources)

	sb.WriteString("resource timelines:\n")
	for _, r := range resources {
		bks := byRes[r]
		sort.Slice(bks, func(i, j int) bool { return bks[i].Start < bks[j].Start })
		fmt.Fprintf(&sb, "  %s %s:\n", r, resType[r])
		for _, b := range bks {
			fmt.Fprintf(&sb, "    [%d,%d) %s stage %d (disinfection [%d,%d) .. [%d,%d))\n",
				b.Start, b.End, b.RequestID, b.Stage,
				b.Start-p.BufferBefore, b.Start, b.End, b.End+p.BufferAfter)
		}
		if len(bks) == 0 {
			sb.WriteString("    (idle)\n")
		}
	}

	sb.WriteString("inter-stage certificates:\n")
	byReq := map[string][]Booking{}
	for _, b := range plan.Bookings {
		byReq[b.RequestID] = append(byReq[b.RequestID], b)
	}
	any := false
	for _, r := range p.Requests {
		bks := byReq[r.ID]
		if len(bks) != 2 {
			continue
		}
		any = true
		sort.Slice(bks, func(i, j int) bool { return bks[i].Stage < bks[j].Stage })
		gap := bks[1].Start - bks[0].End
		fmt.Fprintf(&sb, "  %s: stage0 ends %d, stage1 starts %d, gap %d in [%d,%d]\n",
			r.ID, bks[0].End, bks[1].Start, gap, r.MinGap, r.MaxGap)
	}
	if !any {
		sb.WriteString("  (no scheduled two-stage requests)\n")
	}
	return sb.String()
}
