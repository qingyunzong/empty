package planner

import (
	"math/rand"
	"strings"
	"testing"
)

// bruteForce is an independent, complete search over every subset of
// requests and every placement combination, used to cross-check Solve.
func bruteForce(p *Problem) (bestProfit, bestChanges int) {
	n := len(p.Requests)
	old := map[string]map[int]Booking{}
	oldReqs := map[string]bool{}
	for _, b := range p.OldPlan {
		if old[b.RequestID] == nil {
			old[b.RequestID] = map[int]Booking{}
		}
		old[b.RequestID][b.Stage] = b
		oldReqs[b.RequestID] = true
	}
	reqIndex := map[string]int{}
	for i, r := range p.Requests {
		reqIndex[r.ID] = i
	}

	type iv struct{ lo, hi int }
	bestProfit, bestChanges = 0, len(oldReqs)

	var roomsOfType func(string) []string
	roomsOfType = func(typ string) []string {
		var out []string
		for name, t := range p.Rooms {
			if t == typ {
				out = append(out, name)
			}
		}
		return out
	}

	for mask := 0; mask < (1 << n); mask++ {
		profit := 0
		var idxs []int
		for i := 0; i < n; i++ {
			if mask>>i&1 == 1 {
				profit += p.Requests[i].Profit
				idxs = append(idxs, i)
			}
		}
		if profit < bestProfit {
			continue
		}
		dropped := 0
		for id := range oldReqs {
			ri, ok := reqIndex[id]
			if !ok || mask>>ri&1 == 0 {
				dropped++
			}
		}
		if profit == bestProfit && dropped >= bestChanges {
			continue
		}
		occ := map[string][]iv{}
		for _, b := range p.Existing {
			for _, res := range []string{b.Room, b.Equipment} {
				occ[res] = append(occ[res], iv{b.Start - p.BufferBefore, b.End + p.BufferAfter})
			}
		}
		free := func(res string, s, e int) bool {
			for _, x := range occ[res] {
				if s-p.BufferBefore < x.hi && x.lo < e+p.BufferAfter {
					return false
				}
			}
			return true
		}
		bestChForMask := -1
		var rec func(pos, ch int)
		rec = func(pos, ch int) {
			if bestChForMask >= 0 && ch >= bestChForMask {
				return
			}
			if pos == len(idxs) {
				if bestChForMask < 0 || ch < bestChForMask {
					bestChForMask = ch
				}
				return
			}
			r := p.Requests[idxs[pos]]
			var stageRec func(s, prevEnd int, changed bool)
			stageRec = func(s, prevEnd int, changed bool) {
				if s == len(r.Stages) {
					c := ch
					if changed {
						c++
					}
					rec(pos+1, c)
					return
				}
				st := r.Stages[s]
				for _, w := range st.Windows {
					if s > 0 {
						gap := w.Start - prevEnd
						if gap < r.MinGap || gap > r.MaxGap {
							continue
						}
					}
					for _, rm := range roomsOfType(st.RoomType) {
						if !free(rm, w.Start, w.End) || !free(st.Equipment, w.Start, w.End) {
							continue
						}
						diff := changed
						if _, isOld := oldReqs[r.ID]; isOld {
							if ob, ok := old[r.ID][s]; !ok || ob.Room != rm || ob.Start != w.Start || ob.End != w.End {
								diff = true
							}
						}
						occ[rm] = append(occ[rm], iv{w.Start - p.BufferBefore, w.End + p.BufferAfter})
						occ[st.Equipment] = append(occ[st.Equipment], iv{w.Start - p.BufferBefore, w.End + p.BufferAfter})
						stageRec(s+1, w.End, diff)
						occ[rm] = occ[rm][:len(occ[rm])-1]
						occ[st.Equipment] = occ[st.Equipment][:len(occ[st.Equipment])-1]
					}
				}
			}
			stageRec(0, 0, false)
		}
		rec(0, 0)
		if bestChForMask < 0 {
			continue
		}
		total := dropped + bestChForMask
		if profit > bestProfit || (profit == bestProfit && total < bestChanges) {
			bestProfit, bestChanges = profit, total
		}
	}
	return bestProfit, bestChanges
}

func randomProblem(rng *rand.Rand) *Problem {
	p := &Problem{
		Rooms:        map[string]string{"r1": "A", "r2": "A", "r3": "B"},
		BufferBefore: rng.Intn(2),
		BufferAfter:  rng.Intn(2),
	}
	n := 1 + rng.Intn(6)
	for i := 0; i < n; i++ {
		req := Request{
			ID:     string(rune('a' + i)),
			Profit: 1 + rng.Intn(9),
		}
		stages := 1 + rng.Intn(2)
		for s := 0; s < stages; s++ {
			st := Stage{
				RoomType:  []string{"A", "B"}[rng.Intn(2)],
				Equipment: []string{"e1", "e2"}[rng.Intn(2)],
			}
			for k := 0; k < 1+rng.Intn(3); k++ {
				start := rng.Intn(9)
				st.Windows = append(st.Windows, Window{start, start + 1 + rng.Intn(3)})
			}
			req.Stages = append(req.Stages, st)
		}
		if stages == 2 {
			req.MinGap = rng.Intn(3)
			req.MaxGap = req.MinGap + rng.Intn(3)
		}
		p.Requests = append(p.Requests, req)
	}
	// Random old plan: arbitrary placements, only used for tie-break counts.
	for _, r := range p.Requests {
		if rng.Intn(2) == 0 {
			continue
		}
		for s, st := range r.Stages {
			w := st.Windows[rng.Intn(len(st.Windows))]
			p.OldPlan = append(p.OldPlan, Booking{
				RequestID: r.ID, Stage: s,
				Room: "r1", Equipment: st.Equipment,
				Start: w.Start, End: w.End,
			})
		}
	}
	// Occasionally one immovable existing booking.
	if rng.Intn(2) == 0 {
		p.Existing = append(p.Existing, Booking{
			RequestID: "fixed", Stage: 0,
			Room: "r2", Equipment: "e1", Start: 2, End: 4,
		})
	}
	return p
}

func TestExhaustiveSmallState(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	for trial := 0; trial < 500; trial++ {
		p := randomProblem(rng)
		plan, err := Solve(p)
		if err != nil {
			t.Fatalf("trial %d: Solve: %v", trial, err)
		}
		if err := Verify(p, plan); err != nil {
			t.Fatalf("trial %d: %v\nplan: %+v", trial, err, plan)
		}
		wantProfit, wantChanges := bruteForce(p)
		if plan.Profit != wantProfit || plan.Changes != wantChanges {
			t.Fatalf("trial %d: Solve=(profit %d, changes %d), brute force=(%d, %d)",
				trial, plan.Profit, plan.Changes, wantProfit, wantChanges)
		}
	}
}

func TestTwoStageGapAndCancelSemantics(t *testing.T) {
	p := &Problem{
		Rooms: map[string]string{"r1": "A"},
		Requests: []Request{
			{
				ID: "x", Profit: 10,
				Stages: []Stage{
					{RoomType: "A", Equipment: "e1", Windows: []Window{{0, 2}}},
					{RoomType: "A", Equipment: "e1", Windows: []Window{{10, 12}}},
				},
				MinGap: 1, MaxGap: 3, // actual gap would be 8: infeasible
			},
		},
	}
	plan, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Profit != 0 || len(plan.Bookings) != 0 {
		t.Fatalf("infeasible two-stage request must be dropped wholly, got %+v", plan)
	}
	if err := Verify(p, plan); err != nil {
		t.Fatal(err)
	}

	// Relax the gap: now both stages must appear.
	p.Requests[0].MaxGap = 8
	plan, err = Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Profit != 10 || len(plan.Bookings) != 2 {
		t.Fatalf("expected both stages scheduled, got %+v", plan)
	}
	if err := Verify(p, plan); err != nil {
		t.Fatal(err)
	}
	cert := Certificate(p, plan)
	if !strings.Contains(cert, "x: stage0 ends 2, stage1 starts 10, gap 8 in [1,8]") {
		t.Fatalf("certificate missing inter-stage proof:\n%s", cert)
	}
}

func TestExistingBookingsImmovable(t *testing.T) {
	p := &Problem{
		Rooms: map[string]string{"r1": "A"},
		Existing: []Booking{
			{RequestID: "fixed", Stage: 0, Room: "r1", Equipment: "e1", Start: 0, End: 5},
		},
		BufferAfter: 2,
		Requests: []Request{
			{ID: "a", Profit: 7, Stages: []Stage{
				{RoomType: "A", Equipment: "e1", Windows: []Window{{3, 6}, {8, 10}}},
			}},
		},
	}
	plan, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Profit != 7 {
		t.Fatalf("expected request a at [8,10), got %+v", plan)
	}
	if plan.Bookings[0].Start != 8 {
		t.Fatalf("buffered conflict at [3,6) should force [8,10), got %+v", plan.Bookings[0])
	}
	if err := Verify(p, plan); err != nil {
		t.Fatal(err)
	}

	// A tampered plan conflicting with the confirmed booking must fail Verify.
	bad := &Plan{Profit: 7, Bookings: []Booking{
		{RequestID: "a", Stage: 0, Room: "r1", Equipment: "e1", Start: 3, End: 6},
	}}
	if err := Verify(p, bad); err == nil {
		t.Fatal("Verify must reject a plan conflicting with the confirmed booking")
	}
}

func TestTieBreakMinChanges(t *testing.T) {
	mk := func() *Problem {
		return &Problem{
			Rooms: map[string]string{"r1": "A", "r2": "A"},
			Requests: []Request{
				{ID: "a", Profit: 5, Stages: []Stage{
					{RoomType: "A", Equipment: "e1", Windows: []Window{{0, 3}}},
				}},
				{ID: "b", Profit: 5, Stages: []Stage{
					{RoomType: "A", Equipment: "e2", Windows: []Window{{0, 3}}},
				}},
			},
		}
	}
	// Old plan: a in r1, b in r2. An equal-profit alternative swaps rooms.
	p := mk()
	p.OldPlan = []Booking{
		{RequestID: "a", Stage: 0, Room: "r1", Equipment: "e1", Start: 0, End: 3},
		{RequestID: "b", Stage: 0, Room: "r2", Equipment: "e2", Start: 0, End: 3},
	}
	plan, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Profit != 10 || plan.Changes != 0 {
		t.Fatalf("expected profit 10 with 0 changes, got %+v", plan)
	}
	for _, b := range plan.Bookings {
		want := map[string]string{"a": "r1", "b": "r2"}[b.RequestID]
		if b.Room != want {
			t.Fatalf("request %s moved to %s, want %s", b.RequestID, b.Room, want)
		}
	}

	// Old plan: only a in r1. Keeping a and adding b in r2 costs 0 changes.
	p2 := mk()
	p2.OldPlan = []Booking{
		{RequestID: "a", Stage: 0, Room: "r1", Equipment: "e1", Start: 0, End: 3},
	}
	plan2, err := Solve(p2)
	if err != nil {
		t.Fatal(err)
	}
	if plan2.Profit != 10 || plan2.Changes != 0 {
		t.Fatalf("expected profit 10 with 0 changes, got %+v", plan2)
	}
}

func TestCertificateAndTimeline(t *testing.T) {
	p := &Problem{
		Rooms:        map[string]string{"r1": "A", "r2": "B"},
		BufferBefore: 1, BufferAfter: 1,
		Requests: []Request{
			{ID: "a", Profit: 4, Stages: []Stage{
				{RoomType: "A", Equipment: "e1", Windows: []Window{{0, 2}}},
				{RoomType: "B", Equipment: "e2", Windows: []Window{{4, 6}}},
			}, MinGap: 1, MaxGap: 5},
		},
	}
	plan, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	cert := Certificate(p, plan)
	for _, want := range []string{"r1 room(A)", "e1 equipment", "disinfection", "gap 2 in [1,5]"} {
		if !strings.Contains(cert, want) {
			t.Fatalf("certificate missing %q:\n%s", want, cert)
		}
	}
	if err := Verify(p, plan); err != nil {
		t.Fatal(err)
	}
	// Tamper: shrink the gap below MinGap.
	bad := &Plan{Profit: 4, Bookings: []Booking{
		{RequestID: "a", Stage: 0, Room: "r1", Equipment: "e1", Start: 0, End: 2},
		{RequestID: "a", Stage: 1, Room: "r2", Equipment: "e2", Start: 2, End: 4},
	}}
	if err := Verify(p, bad); err == nil {
		t.Fatal("Verify must reject window/gap tampering")
	}
}

func TestTooManyRequests(t *testing.T) {
	p := &Problem{Rooms: map[string]string{"r1": "A"}}
	for i := 0; i < MaxRequests+1; i++ {
		p.Requests = append(p.Requests, Request{
			ID: string(rune('a' + i)), Profit: 1,
			Stages: []Stage{{RoomType: "A", Equipment: "e1", Windows: []Window{{i, i + 1}}}},
		})
	}
	if _, err := Solve(p); err == nil {
		t.Fatal("expected error for more than 16 requests")
	}
}

func TestSixteenRequests(t *testing.T) {
	p := &Problem{Rooms: map[string]string{"r1": "A", "r2": "A"}}
	for i := 0; i < MaxRequests; i++ {
		p.Requests = append(p.Requests, Request{
			ID: string(rune('a' + i)), Profit: 1 + i%3,
			Stages: []Stage{{RoomType: "A", Equipment: "e1",
				Windows: []Window{{2 * i, 2*i + 1}, {2*i + 1, 2*i + 2}}}},
		})
	}
	plan, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(p, plan); err != nil {
		t.Fatal(err)
	}
	wantProfit, wantChanges := bruteForce(p)
	if plan.Profit != wantProfit || plan.Changes != wantChanges {
		t.Fatalf("Solve=(%d,%d), brute force=(%d,%d)",
			plan.Profit, plan.Changes, wantProfit, wantChanges)
	}
}
