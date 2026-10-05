package sched

import (
	"errors"
	"testing"
)

func oneStageRequest(id string, profit int, roomType, equip string, before, after int, wins ...Window) Request {
	return Request{
		ID:     id,
		Profit: profit,
		Stages: []Stage{{
			RoomType:  roomType,
			Equipment: equip,
			Before:    before,
			After:     after,
			Windows:   wins,
		}},
	}
}

func baseProblem() *Problem {
	return &Problem{
		Rooms: []Room{
			{ID: "R1", Type: "A"},
			{ID: "R2", Type: "A"},
			{ID: "R3", Type: "B"},
		},
		Equipment: []string{"E1", "E2"},
		OldPlan:   map[string]*PlanEntry{},
	}
}

func solveAndVerify(t *testing.T, p *Problem) *Solution {
	t.Helper()
	sol, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if err := Verify(p, sol); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	return sol
}

// Small instance where everything fits: all requests must be selected.
func TestSelectsAllWhenEverythingFits(t *testing.T) {
	p := baseProblem()
	p.Requests = []Request{
		oneStageRequest("a", 5, "A", "E1", 1, 1, Window{0, 3}),
		oneStageRequest("b", 7, "A", "E2", 1, 1, Window{0, 3}),
		oneStageRequest("c", 4, "B", "E1", 0, 0, Window{10, 12}),
	}
	sol := solveAndVerify(t, p)
	if sol.Profit != 16 || len(sol.Assignments) != 3 {
		t.Fatalf("want all 3 selected with profit 16, got profit %d, %d assignments", sol.Profit, len(sol.Assignments))
	}
	if sol.Changes != 3 {
		t.Fatalf("empty old plan: want 3 changes, got %d", sol.Changes)
	}
}

func TestConflictSelectsHigherProfit(t *testing.T) {
	p := baseProblem()
	p.Requests = []Request{
		oneStageRequest("low", 3, "A", "E1", 0, 0, Window{0, 5}),
		oneStageRequest("high", 9, "A", "E1", 0, 0, Window{2, 6}),
	}
	sol := solveAndVerify(t, p)
	if sol.Profit != 9 {
		t.Fatalf("want profit 9, got %d", sol.Profit)
	}
	if _, ok := sol.Assignments["high"]; !ok {
		t.Fatal("high-profit request not scheduled")
	}
	if _, ok := sol.Assignments["low"]; ok {
		t.Fatal("conflicting low-profit request should be rejected")
	}
}

// Adjacent windows fit without disinfection but conflict once the
// after-buffer of the first overlaps the second.
func TestDisinfectionBufferBlocksAdjacency(t *testing.T) {
	mk := func(after int) *Problem {
		p := baseProblem()
		p.Requests = []Request{
			oneStageRequest("x", 5, "A", "E1", 0, after, Window{0, 4}),
			oneStageRequest("y", 5, "A", "E1", 0, 0, Window{4, 8}),
		}
		p.OldPlan = map[string]*PlanEntry{
			"x": {Windows: []int{0}, Rooms: []string{"R1"}},
			"y": {Windows: []int{0}, Rooms: []string{"R1"}},
		}
		return p
	}
	sol := solveAndVerify(t, mk(0))
	if sol.Profit != 10 {
		t.Fatalf("no buffer: want both scheduled (profit 10), got %d", sol.Profit)
	}
	sol = solveAndVerify(t, mk(2))
	if sol.Profit != 5 || len(sol.Assignments) != 1 {
		t.Fatalf("buffer 2: want exactly one scheduled (profit 5), got profit %d, %d assignments", sol.Profit, len(sol.Assignments))
	}
}

func TestTwoStageGapBounds(t *testing.T) {
	mk := func(minGap, maxGap int) *Problem {
		p := baseProblem()
		p.Requests = []Request{{
			ID:     "two",
			Profit: 10,
			Stages: []Stage{
				{RoomType: "A", Equipment: "E1", Windows: []Window{{0, 4}}},
				{RoomType: "B", Equipment: "E2", MinGap: minGap, MaxGap: maxGap,
					Windows: []Window{{4, 6}, {8, 10}, {30, 32}}},
			},
		}}
		return p
	}
	// MinGap 3 forbids the window starting at 4 (gap 0); MaxGap 10 keeps 8.
	sol := solveAndVerify(t, mk(3, 10))
	entry, ok := sol.Assignments["two"]
	if !ok {
		t.Fatal("two-stage request should be schedulable")
	}
	if entry.Windows[1] != 1 {
		t.Fatalf("want second stage at window 1 (start 8), got window %d", entry.Windows[1])
	}
	if len(sol.StageGaps) != 1 || sol.StageGaps[0].Gap != 4 {
		t.Fatalf("bad stage-gap certificate: %+v", sol.StageGaps)
	}
	// No candidate window satisfies a gap in [5, 6]: whole order cancelled.
	sol = solveAndVerify(t, mk(5, 6))
	if sol.Profit != 0 || len(sol.Assignments) != 0 {
		t.Fatalf("impossible gap: want empty plan, got profit %d, %d assignments", sol.Profit, len(sol.Assignments))
	}
}

// A two-stage request whose second stage cannot be placed contributes no
// profit and leaves no trace of its first stage on any resource.
func TestPartialStageNeverScheduled(t *testing.T) {
	p := baseProblem()
	p.Requests = []Request{
		{
			ID:     "blocked",
			Profit: 10,
			Stages: []Stage{
				{RoomType: "A", Equipment: "E1", Windows: []Window{{0, 4}}},
				{RoomType: "B", Equipment: "E2", MinGap: 0, MaxGap: 1, Windows: []Window{{4, 6}}},
			},
		},
		oneStageRequest("occupier", 100, "B", "E2", 0, 0, Window{3, 7}),
	}
	sol := solveAndVerify(t, p)
	if _, ok := sol.Assignments["blocked"]; ok {
		t.Fatal("request with unplaceable second stage must be fully cancelled")
	}
	for _, tl := range sol.Timelines {
		for _, e := range tl.Entries {
			if e.RequestID == "blocked" {
				t.Fatalf("cancelled request occupies %s", tl.ResourceID)
			}
		}
	}
}

func TestLockedBookingImmovable(t *testing.T) {
	p := baseProblem()
	locked := oneStageRequest("locked", 5, "A", "E1", 0, 0, Window{0, 5})
	locked.Locked = &PlanEntry{Windows: []int{0}, Rooms: []string{"R1"}}
	p.Requests = []Request{
		locked,
		oneStageRequest("intruder", 100, "A", "E1", 0, 0, Window{2, 6}, Window{20, 22}),
	}
	p.OldPlan = map[string]*PlanEntry{"locked": {Windows: []int{0}, Rooms: []string{"R1"}}}
	sol := solveAndVerify(t, p)
	entry := sol.Assignments["locked"]
	if !entryEqual(&entry, locked.Locked) {
		t.Fatalf("locked booking moved to %+v", entry)
	}
	// The intruder must take its non-conflicting window despite lower value.
	if got := sol.Assignments["intruder"].Windows[0]; got != 1 {
		t.Fatalf("intruder should move to window 1, got %d", got)
	}
	if sol.Changes != 1 {
		t.Fatalf("want 1 change (new intruder), got %d", sol.Changes)
	}
}

func TestConflictingLockedBookingsAreInfeasible(t *testing.T) {
	p := baseProblem()
	a := oneStageRequest("la", 5, "A", "E1", 0, 0, Window{0, 5})
	a.Locked = &PlanEntry{Windows: []int{0}, Rooms: []string{"R1"}}
	b := oneStageRequest("lb", 5, "A", "E2", 0, 0, Window{2, 6})
	b.Locked = &PlanEntry{Windows: []int{0}, Rooms: []string{"R1"}}
	p.Requests = []Request{a, b}
	if _, err := Solve(p); !errors.Is(err, ErrInfeasible) {
		t.Fatalf("want ErrInfeasible, got %v", err)
	}
}

// Equal profit either way: the solver must keep the old placement.
func TestTieBreakPrefersOldPlan(t *testing.T) {
	p := baseProblem()
	p.Requests = []Request{
		oneStageRequest("keep", 5, "A", "E1", 0, 0, Window{0, 4}, Window{10, 14}),
	}
	p.OldPlan = map[string]*PlanEntry{"keep": {Windows: []int{0}, Rooms: []string{"R1"}}}
	sol := solveAndVerify(t, p)
	entry := sol.Assignments["keep"]
	if entry.Windows[0] != 0 || entry.Rooms[0] != "R1" {
		t.Fatalf("tie-break should keep old placement, got %+v", entry)
	}
	if sol.Changes != 0 {
		t.Fatalf("want 0 changes, got %d", sol.Changes)
	}
}

func TestCertificatesContent(t *testing.T) {
	p := baseProblem()
	p.Requests = []Request{{
		ID:     "two",
		Profit: 10,
		Stages: []Stage{
			{RoomType: "A", Equipment: "E1", Before: 1, After: 2, Windows: []Window{{5, 9}}},
			{RoomType: "B", Equipment: "E2", Before: 0, After: 1, MinGap: 2, MaxGap: 6,
				Windows: []Window{{13, 15}}},
		},
	}}
	sol := solveAndVerify(t, p)
	var r1, e1 *ResourceTimeline
	for i := range sol.Timelines {
		switch sol.Timelines[i].ResourceID {
		case "R1", "R2":
			if sol.Timelines[i].Kind != "room" {
				t.Fatalf("bad kind: %+v", sol.Timelines[i])
			}
		case "E1":
			e1 = &sol.Timelines[i]
		}
	}
	_ = r1
	if e1 == nil || len(e1.Entries) != 1 {
		t.Fatalf("E1 timeline: %+v", e1)
	}
	e := e1.Entries[0]
	if e.Core != (Interval{5, 9}) || e.Busy != (Interval{4, 11}) {
		t.Fatalf("bad core/busy interval: %+v", e)
	}
	if len(sol.StageGaps) != 1 {
		t.Fatalf("want 1 stage-gap certificate, got %d", len(sol.StageGaps))
	}
	g := sol.StageGaps[0]
	if g.Gap != 4 || g.MinGap != 2 || g.MaxGap != 6 || g.FirstEnd != 9 || g.SecondStart != 13 {
		t.Fatalf("bad stage-gap certificate: %+v", g)
	}
}

func TestValidationErrors(t *testing.T) {
	p := baseProblem()
	p.Requests = []Request{oneStageRequest("bad", 1, "Z", "E1", 0, 0, Window{0, 1})}
	if _, err := Solve(p); err == nil {
		t.Fatal("unknown room type should be rejected")
	}
	p = baseProblem()
	p.Requests = []Request{oneStageRequest("bad", 1, "A", "E9", 0, 0, Window{0, 1})}
	if _, err := Solve(p); err == nil {
		t.Fatal("unknown equipment should be rejected")
	}
}
