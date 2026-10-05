package sched

import (
	"errors"
	"fmt"
	"math"
)

// ErrInfeasible is returned when locked (confirmed) bookings cannot all be
// placed without violating resource or gap constraints.
var ErrInfeasible = errors.New("sched: locked bookings are infeasible")

// Solve finds a maximum-profit feasible set of placements. Ties in profit
// are broken by minimizing the number of requests whose placement differs
// from OldPlan. Remaining ties are broken deterministically by option
// order. It returns ErrInfeasible if the locked bookings conflict.
func Solve(p *Problem) (*Solution, error) {
	if err := validate(p); err != nil {
		return nil, err
	}
	s := newSolver(p)
	s.dfs(0)
	if !s.found {
		return nil, ErrInfeasible
	}
	sol := &Solution{
		Profit:      s.bestProfit,
		Changes:     s.bestChanges,
		Assignments: s.bestAssign,
	}
	sol.Timelines = BuildTimelines(p, sol.Assignments)
	sol.StageGaps = BuildStageGaps(p, sol.Assignments)
	return sol, nil
}

func validate(p *Problem) error {
	roomIDs := map[string]bool{}
	roomTypes := map[string]bool{}
	for _, r := range p.Rooms {
		if r.ID == "" {
			return errors.New("sched: room with empty ID")
		}
		if roomIDs[r.ID] {
			return fmt.Errorf("sched: duplicate room ID %q", r.ID)
		}
		roomIDs[r.ID] = true
		roomTypes[r.Type] = true
	}
	equip := map[string]bool{}
	for _, e := range p.Equipment {
		if equip[e] {
			return fmt.Errorf("sched: duplicate equipment ID %q", e)
		}
		if roomIDs[e] {
			return fmt.Errorf("sched: resource ID %q used as both room and equipment", e)
		}
		equip[e] = true
	}
	seen := map[string]bool{}
	for i := range p.Requests {
		req := &p.Requests[i]
		if req.ID == "" {
			return errors.New("sched: request with empty ID")
		}
		if seen[req.ID] {
			return fmt.Errorf("sched: duplicate request ID %q", req.ID)
		}
		seen[req.ID] = true
		if len(req.Stages) < 1 || len(req.Stages) > 2 {
			return fmt.Errorf("sched: request %q must have 1 or 2 stages", req.ID)
		}
		for j, st := range req.Stages {
			if !roomTypes[st.RoomType] {
				return fmt.Errorf("sched: request %q stage %d: unknown room type %q", req.ID, j, st.RoomType)
			}
			if !equip[st.Equipment] {
				return fmt.Errorf("sched: request %q stage %d: unknown equipment %q", req.ID, j, st.Equipment)
			}
			if st.Before < 0 || st.After < 0 {
				return fmt.Errorf("sched: request %q stage %d: negative disinfection buffer", req.ID, j)
			}
			if len(st.Windows) == 0 {
				return fmt.Errorf("sched: request %q stage %d: no candidate windows", req.ID, j)
			}
			for k, w := range st.Windows {
				if w.Start < 0 || w.End <= w.Start {
					return fmt.Errorf("sched: request %q stage %d: invalid window %d", req.ID, j, k)
				}
			}
			if j > 0 {
				if st.MinGap < 0 {
					return fmt.Errorf("sched: request %q stage %d: negative MinGap", req.ID, j)
				}
				if st.MaxGap >= 0 && st.MaxGap < st.MinGap {
					return fmt.Errorf("sched: request %q stage %d: MaxGap < MinGap", req.ID, j)
				}
			}
		}
		if req.Locked != nil {
			if err := checkEntryShape(p, req, req.Locked); err != nil {
				return fmt.Errorf("sched: locked placement of %q: %w", req.ID, err)
			}
		}
	}
	for id, e := range p.OldPlan {
		req := findRequest(p, id)
		if req == nil || e == nil {
			continue // stale or empty old entries are ignored
		}
		if err := checkEntryShape(p, req, e); err != nil {
			return fmt.Errorf("sched: old plan entry for %q: %w", id, err)
		}
	}
	return nil
}

func findRequest(p *Problem, id string) *Request {
	for i := range p.Requests {
		if p.Requests[i].ID == id {
			return &p.Requests[i]
		}
	}
	return nil
}

func checkEntryShape(p *Problem, req *Request, e *PlanEntry) error {
	if len(e.Windows) != len(req.Stages) || len(e.Rooms) != len(req.Stages) {
		return fmt.Errorf("entry has %d windows/%d rooms for %d stages",
			len(e.Windows), len(e.Rooms), len(req.Stages))
	}
	for j, st := range req.Stages {
		if e.Windows[j] < 0 || e.Windows[j] >= len(st.Windows) {
			return fmt.Errorf("stage %d: window index %d out of range", j, e.Windows[j])
		}
		ok := false
		for _, r := range p.Rooms {
			if r.ID == e.Rooms[j] {
				if r.Type != st.RoomType {
					return fmt.Errorf("stage %d: room %q has type %q, need %q", j, r.ID, r.Type, st.RoomType)
				}
				ok = true
			}
		}
		if !ok {
			return fmt.Errorf("stage %d: unknown room %q", j, e.Rooms[j])
		}
	}
	return nil
}

// block is one resource occupation of a placement.
type block struct {
	res        string
	start, end int
}

type placement struct {
	entry  PlanEntry
	blocks []block
}

// buildPlacement checks the inter-stage gap limits and computes the
// resource blocks (disinfection buffers included) of a placement.
func buildPlacement(req *Request, wins []int, rooms []string) (placement, bool) {
	pl := placement{entry: PlanEntry{
		Windows: append([]int(nil), wins...),
		Rooms:   append([]string(nil), rooms...),
	}}
	for j, st := range req.Stages {
		w := st.Windows[wins[j]]
		if j > 0 {
			prev := req.Stages[j-1].Windows[wins[j-1]]
			gap := w.Start - prev.End
			if gap < st.MinGap || (st.MaxGap >= 0 && gap > st.MaxGap) {
				return placement{}, false
			}
		}
		busy := Interval{Start: w.Start - st.Before, End: w.End + st.After}
		pl.blocks = append(pl.blocks,
			block{res: rooms[j], start: busy.Start, end: busy.End},
			block{res: st.Equipment, start: busy.Start, end: busy.End},
		)
	}
	// The stages of one request must not collide with each other on a
	// shared resource (possible once disinfection buffers are added).
	for a := 0; a < len(pl.blocks); a++ {
		for b := a + 1; b < len(pl.blocks); b++ {
			x, y := pl.blocks[a], pl.blocks[b]
			if x.res == y.res && x.start < y.end && y.start < x.end {
				return placement{}, false
			}
		}
	}
	return pl, true
}

type solver struct {
	p       *Problem
	options [][]placement
	locked  []bool
	occ     map[string][]Interval
	rem     []int // suffix sum of positive profits (upper bound)

	curProfit, curChanges int
	cur                   map[string]PlanEntry

	bestProfit, bestChanges int
	bestAssign              map[string]PlanEntry
	found                   bool
}

func newSolver(p *Problem) *solver {
	s := &solver{
		p:           p,
		occ:         map[string][]Interval{},
		cur:         map[string]PlanEntry{},
		bestProfit:  math.MinInt,
		bestChanges: math.MaxInt,
	}
	roomsByType := map[string][]string{}
	for _, r := range p.Rooms {
		roomsByType[r.Type] = append(roomsByType[r.Type], r.ID)
	}
	n := len(p.Requests)
	s.rem = make([]int, n+1)
	for i := n - 1; i >= 0; i-- {
		s.rem[i] = s.rem[i+1]
		if p.Requests[i].Profit > 0 {
			s.rem[i] += p.Requests[i].Profit
		}
	}
	for i := range p.Requests {
		req := &p.Requests[i]
		s.locked = append(s.locked, req.Locked != nil)
		if req.Locked != nil {
			if pl, ok := buildPlacement(req, req.Locked.Windows, req.Locked.Rooms); ok {
				s.options = append(s.options, []placement{pl})
			} else {
				s.options = append(s.options, nil) // locked but gap-infeasible
			}
			continue
		}
		var opts []placement
		for w0 := range req.Stages[0].Windows {
			for _, r0 := range roomsByType[req.Stages[0].RoomType] {
				if len(req.Stages) == 1 {
					if pl, ok := buildPlacement(req, []int{w0}, []string{r0}); ok {
						opts = append(opts, pl)
					}
					continue
				}
				for w1 := range req.Stages[1].Windows {
					for _, r1 := range roomsByType[req.Stages[1].RoomType] {
						if pl, ok := buildPlacement(req, []int{w0, w1}, []string{r0, r1}); ok {
							opts = append(opts, pl)
						}
					}
				}
			}
		}
		s.options = append(s.options, opts)
	}
	return s
}

func (s *solver) fits(pl *placement) bool {
	for _, b := range pl.blocks {
		for _, iv := range s.occ[b.res] {
			if b.start < iv.End && iv.Start < b.end {
				return false
			}
		}
	}
	return true
}

func (s *solver) place(pl *placement) {
	for _, b := range pl.blocks {
		s.occ[b.res] = append(s.occ[b.res], Interval{Start: b.start, End: b.end})
	}
}

func (s *solver) unplace(pl *placement) {
	for _, b := range pl.blocks {
		s.occ[b.res] = s.occ[b.res][:len(s.occ[b.res])-1]
	}
}

func entryEqual(a, b *PlanEntry) bool {
	if a == nil || b == nil {
		return a == b
	}
	if len(a.Windows) != len(b.Windows) || len(a.Rooms) != len(b.Rooms) {
		return false
	}
	for i := range a.Windows {
		if a.Windows[i] != b.Windows[i] || a.Rooms[i] != b.Rooms[i] {
			return false
		}
	}
	return true
}

// CountChanges reports how many requests differ between the old plan and
// the given assignments (newly scheduled, cancelled, or moved to a
// different window or room).
func CountChanges(p *Problem, assignments map[string]PlanEntry) int {
	changes := 0
	for i := range p.Requests {
		req := &p.Requests[i]
		old := p.OldPlan[req.ID]
		cur, ok := assignments[req.ID]
		var curPtr *PlanEntry
		if ok {
			c := cur
			curPtr = &c
		}
		if !entryEqual(old, curPtr) {
			changes++
		}
	}
	return changes
}

func (s *solver) dfs(i int) {
	if s.curProfit+s.rem[i] < s.bestProfit {
		return
	}
	if i == len(s.options) {
		s.found = true
		if s.curProfit > s.bestProfit ||
			(s.curProfit == s.bestProfit && s.curChanges < s.bestChanges) {
			s.bestProfit = s.curProfit
			s.bestChanges = s.curChanges
			s.bestAssign = make(map[string]PlanEntry, len(s.cur))
			for k, v := range s.cur {
				s.bestAssign[k] = v
			}
		}
		return
	}
	req := &s.p.Requests[i]
	old := s.p.OldPlan[req.ID]
	for k := range s.options[i] {
		pl := &s.options[i][k]
		if !s.fits(pl) {
			continue
		}
		s.place(pl)
		s.cur[req.ID] = pl.entry
		delta := 0
		if !entryEqual(old, &pl.entry) {
			delta = 1
		}
		s.curProfit += req.Profit
		s.curChanges += delta
		s.dfs(i + 1)
		s.curProfit -= req.Profit
		s.curChanges -= delta
		delete(s.cur, req.ID)
		s.unplace(pl)
	}
	if !s.locked[i] {
		delta := 0
		if old != nil {
			delta = 1
		}
		s.curChanges += delta
		s.dfs(i + 1)
		s.curChanges -= delta
	}
}
