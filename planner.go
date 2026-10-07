// Package planner selects a maximum-profit subset of booking requests and
// assigns rooms, equipment and time windows to each stage, respecting
// disinfection buffers, two-stage gap limits and immovable existing bookings.
package planner

import (
	"errors"
	"fmt"
	"sort"
)

// Window is a candidate occupancy interval [Start, End).
type Window struct {
	Start, End int
}

// Stage describes one stage of a request: it needs a room of RoomType and
// the named Equipment, occupied during one of the candidate Windows.
type Stage struct {
	RoomType  string
	Equipment string
	Windows   []Window
}

// Request is a bookable order with one or two stages. For two-stage
// requests the gap between stage 0 end and stage 1 start must lie in
// [MinGap, MaxGap]. A request is scheduled wholly or not at all: cancelling
// one stage cancels the whole order.
type Request struct {
	ID             string
	Profit         int
	Stages         []Stage
	MinGap, MaxGap int
}

// Booking is a concrete placement of one request stage.
type Booking struct {
	RequestID string
	Stage     int
	Room      string
	Equipment string
	Start     int
	End       int
}

// Problem is a full planning instance. Rooms maps room name to room type.
// BufferBefore/BufferAfter are disinfection intervals blocking a resource
// around every occupancy. Existing holds confirmed bookings that must not
// move. OldPlan is the previous plan used for the min-change tie-break.
type Problem struct {
	Rooms        map[string]string
	BufferBefore int
	BufferAfter  int
	Requests     []Request
	Existing     []Booking
	OldPlan      []Booking
}

// Plan is the solver output.
type Plan struct {
	Bookings []Booking
	Profit   int
	Changes  int // old-plan requests dropped or moved
}

// MaxRequests bounds the request count so subset enumeration stays exact.
const MaxRequests = 16

// interval is a blocked half-open range on one resource.
type interval struct{ lo, hi int }

type occupancy map[string][]interval

func (o occupancy) blocked(resource string, b Booking, p *Problem) bool {
	lo, hi := b.Start-p.BufferBefore, b.End+p.BufferAfter
	for _, iv := range o[resource] {
		if lo < iv.hi && iv.lo < hi {
			return true
		}
	}
	return false
}

func (o occupancy) place(resource string, b Booking, p *Problem) {
	o[resource] = append(o[resource], interval{b.Start - p.BufferBefore, b.End + p.BufferAfter})
}

func (o occupancy) remove(resource string, p *Problem) {
	s := o[resource]
	o[resource] = s[:len(s)-1]
}

// placement is one concrete option for one stage.
type placement struct {
	room  string
	win   Window
	stage int
}

// Solve returns a maximum-profit feasible plan; among equal-profit plans it
// minimizes changes relative to p.OldPlan (dropped or moved old requests).
func Solve(p *Problem) (*Plan, error) {
	n := len(p.Requests)
	if n > MaxRequests {
		return nil, fmt.Errorf("too many requests: %d > %d", n, MaxRequests)
	}
	for _, r := range p.Requests {
		if len(r.Stages) == 0 || len(r.Stages) > 2 {
			return nil, fmt.Errorf("request %s: need 1 or 2 stages, got %d", r.ID, len(r.Stages))
		}
	}

	// Old-plan placements keyed by request then stage.
	old := map[string]map[int]Booking{}
	oldReqs := map[string]bool{}
	for _, b := range p.OldPlan {
		if old[b.RequestID] == nil {
			old[b.RequestID] = map[int]Booking{}
		}
		old[b.RequestID][b.Stage] = b
		oldReqs[b.RequestID] = true
	}

	// Base occupancy from immovable existing bookings.
	base := occupancy{}
	for _, b := range p.Existing {
		if base.blocked(b.Room, b, p) || base.blocked(b.Equipment, b, p) {
			return nil, fmt.Errorf("existing booking %s stage %d conflicts", b.RequestID, b.Stage)
		}
		base.place(b.Room, b, p)
		base.place(b.Equipment, b, p)
	}

	// Candidate placements per request stage.
	cand := make([][][]placement, n)
	for i, r := range p.Requests {
		cand[i] = make([][]placement, len(r.Stages))
		for s, st := range r.Stages {
			var rooms []string
			for name, typ := range p.Rooms {
				if typ == st.RoomType {
					rooms = append(rooms, name)
				}
			}
			sort.Strings(rooms)
			for _, w := range st.Windows {
				if w.Start >= w.End {
					return nil, fmt.Errorf("request %s stage %d: bad window", r.ID, s)
				}
				for _, rm := range rooms {
					cand[i][s] = append(cand[i][s], placement{room: rm, win: w, stage: s})
				}
			}
		}
	}

	reqIndex := map[string]int{}
	for i, r := range p.Requests {
		reqIndex[r.ID] = i
	}

	best := &Plan{Profit: 0, Changes: len(oldReqs)}

	// profitOf and droppedOld are cheap subset statistics for pruning.
	profits := make([]int, n)
	for i, r := range p.Requests {
		profits[i] = r.Profit
	}

	var search func(mask int) (int, []Booking, bool)
	search = func(mask int) (int, []Booking, bool) {
		// Backtracking over requests in the subset, stage by stage,
		// minimizing per-request changes vs the old plan.
		var idxs []int
		for i := 0; i < n; i++ {
			if mask>>i&1 == 1 {
				idxs = append(idxs, i)
			}
		}
		occ := occupancy{}
		for k, v := range base {
			occ[k] = append([]interval(nil), v...)
		}
		bestCh := int(^uint(0) >> 1)
		var bestBk []Booking
		var cur []Booking
		// changed tracks whether the current request already differs.
		var rec func(pos int, changes int)
		rec = func(pos int, changes int) {
			if changes >= bestCh {
				return
			}
			if pos == len(idxs) {
				bestCh = changes
				bestBk = append([]Booking(nil), cur...)
				return
			}
			ri := idxs[pos]
			r := p.Requests[ri]
			// Schedule stages of this request sequentially.
			var stageRec func(s int, prevEnd int, changed bool)
			stageRec = func(s int, prevEnd int, changed bool) {
				if changes+boolInt(changed) >= bestCh {
					return
				}
				if s == len(r.Stages) {
					rec(pos+1, changes+boolInt(changed))
					return
				}
				for _, pl := range cand[ri][s] {
					if s > 0 {
						gap := pl.win.Start - prevEnd
						if gap < r.MinGap || gap > r.MaxGap {
							continue
						}
					}
					b := Booking{RequestID: r.ID, Stage: s, Room: pl.room,
						Equipment: r.Stages[s].Equipment, Start: pl.win.Start, End: pl.win.End}
					if occ.blocked(b.Room, b, p) || occ.blocked(b.Equipment, b, p) {
						continue
					}
					diff := changed
					if _, isOld := oldReqs[r.ID]; isOld {
						if ob, ok := old[r.ID][s]; !ok || ob.Room != b.Room || ob.Start != b.Start || ob.End != b.End {
							diff = true
						}
					}
					occ.place(b.Room, b, p)
					occ.place(b.Equipment, b, p)
					cur = append(cur, b)
					stageRec(s+1, b.End, diff)
					cur = cur[:len(cur)-1]
					occ.remove(b.Equipment, p)
					occ.remove(b.Room, p)
				}
			}
			stageRec(0, 0, false)
		}
		rec(0, 0)
		if bestBk == nil {
			return 0, nil, false
		}
		return bestCh, bestBk, true
	}

	for mask := 0; mask < (1 << n); mask++ {
		profit := 0
		for i := 0; i < n; i++ {
			if mask>>i&1 == 1 {
				profit += profits[i]
			}
		}
		if profit < best.Profit {
			continue
		}
		dropped := 0
		for id := range oldReqs {
			ri, ok := reqIndex[id]
			if !ok || mask>>ri&1 == 0 {
				dropped++
			}
		}
		if profit == best.Profit && dropped >= best.Changes {
			continue
		}
		ch, bk, ok := search(mask)
		if !ok {
			continue
		}
		total := dropped + ch
		if profit > best.Profit || (profit == best.Profit && total < best.Changes) {
			best = &Plan{Bookings: bk, Profit: profit, Changes: total}
		}
	}

	sort.Slice(best.Bookings, func(i, j int) bool {
		a, b := best.Bookings[i], best.Bookings[j]
		if a.RequestID != b.RequestID {
			return a.RequestID < b.RequestID
		}
		return a.Stage < b.Stage
	})
	if best.Bookings == nil {
		best.Bookings = []Booking{}
	}
	return best, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

var errVerify = errors.New("plan verification failed")

// Verify checks a plan against the problem and returns a descriptive error.
func Verify(p *Problem, plan *Plan) error {
	byReq := map[string][]Booking{}
	for _, b := range plan.Bookings {
		byReq[b.RequestID] = append(byReq[b.RequestID], b)
	}
	profit := 0
	for _, r := range p.Requests {
		bks := byReq[r.ID]
		if len(bks) == 0 {
			continue
		}
		if len(bks) != len(r.Stages) {
			return fmt.Errorf("%w: request %s has %d bookings, want %d stages (partial orders not allowed)",
				errVerify, r.ID, len(bks), len(r.Stages))
		}
		sort.Slice(bks, func(i, j int) bool { return bks[i].Stage < bks[j].Stage })
		prevEnd := 0
		for s, b := range bks {
			if b.Stage != s {
				return fmt.Errorf("%w: request %s duplicate/missing stage %d", errVerify, r.ID, s)
			}
			st := r.Stages[s]
			if p.Rooms[b.Room] != st.RoomType {
				return fmt.Errorf("%w: request %s stage %d room %s is not of type %s",
					errVerify, r.ID, s, b.Room, st.RoomType)
			}
			if b.Equipment != st.Equipment {
				return fmt.Errorf("%w: request %s stage %d equipment %s, want %s",
					errVerify, r.ID, s, b.Equipment, st.Equipment)
			}
			okWin := false
			for _, w := range st.Windows {
				if w.Start == b.Start && w.End == b.End {
					okWin = true
					break
				}
			}
			if !okWin {
				return fmt.Errorf("%w: request %s stage %d window [%d,%d) not a candidate",
					errVerify, r.ID, s, b.Start, b.End)
			}
			if s > 0 {
				gap := b.Start - prevEnd
				if gap < r.MinGap || gap > r.MaxGap {
					return fmt.Errorf("%w: request %s inter-stage gap %d outside [%d,%d]",
						errVerify, r.ID, gap, r.MinGap, r.MaxGap)
				}
			}
			prevEnd = b.End
		}
		profit += r.Profit
	}
	if profit != plan.Profit {
		return fmt.Errorf("%w: reported profit %d, actual %d", errVerify, plan.Profit, profit)
	}

	// Resource conflicts including disinfection buffers and existing bookings.
	occ := occupancy{}
	all := append(append([]Booking(nil), p.Existing...), plan.Bookings...)
	for _, b := range all {
		for _, res := range []string{b.Room, b.Equipment} {
			if occ.blocked(res, b, p) {
				return fmt.Errorf("%w: resource %s conflict at booking %s stage %d (incl. disinfection buffer)",
					errVerify, res, b.RequestID, b.Stage)
			}
			occ.place(res, b, p)
		}
	}

	return nil
}
