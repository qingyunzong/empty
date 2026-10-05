package cut

import (
	"errors"
	"fmt"
	"sort"
)

const (
	MaxPiecesLimit = 16
	MaxBarsLimit   = 8
)

var (
	ErrTooManyPieces = errors.New("too many pieces: limit is 16")
	ErrTooManyBars   = errors.New("maxBars exceeds limit of 8")
	ErrInfeasible    = errors.New("no feasible cutting plan")
	ErrBadJob        = errors.New("invalid job")
)

type piece struct {
	label  string
	length int
}

func expandPieces(job Job) []piece {
	var ps []piece
	seen := map[string]int{}
	for _, d := range job.Demands {
		for i := 0; i < d.Qty; i++ {
			base := d.Label
			if d.Qty > 1 {
				base = fmt.Sprintf("%s#%d", d.Label, i+1)
			}
			label := base
			for k := 2; seen[label] > 0; k++ {
				label = fmt.Sprintf("%s~%d", base, k)
			}
			seen[label]++
			ps = append(ps, piece{label: label, length: d.Length})
		}
	}
	sort.SliceStable(ps, func(i, j int) bool { return ps[i].length > ps[j].length })
	return ps
}

func normMaxBars(job Job) (int, error) {
	mb := job.MaxBars
	if mb == 0 {
		mb = MaxBarsLimit
	}
	if mb < 0 || mb > MaxBarsLimit {
		return 0, ErrTooManyBars
	}
	return mb, nil
}

func validate(job Job) error {
	if job.Kerf < 0 || job.ScrapThreshold < 0 || job.CutCost < 0 {
		return ErrBadJob
	}
	for _, t := range job.StockTypes {
		if t.Length <= 0 || t.Cost < 0 || t.Max < 0 {
			return ErrBadJob
		}
	}
	for _, d := range job.Demands {
		if d.Length <= 0 || d.Qty < 0 {
			return ErrBadJob
		}
	}
	return nil
}

// slot is an open bar being filled during the search.
type slot struct {
	length int
	cost   int
	kind   int // 0 = inventory, 1 = purchased
	refIdx int // inventory index or stock type index
	used   int // sum(pieces) + count*kerf
	count  int
	labels []string
}

type solver struct {
	job       Job
	pieces    []piece
	maxBars   int
	invUsed   []bool
	typeLeft  []int
	slots     []slot
	bestPurch int
	bestScrap int
	bestSlots []slot
	found     bool
}

// Solve finds the optimal plan: lexicographically minimal
// (purchase cost, scrap length). Cut cost is a constant
// len(pieces)*CutCost and is reported in Totals.
func Solve(job Job) (*Plan, error) {
	if err := validate(job); err != nil {
		return nil, err
	}
	maxBars, err := normMaxBars(job)
	if err != nil {
		return nil, err
	}
	pieces := expandPieces(job)
	if len(pieces) > MaxPiecesLimit {
		return nil, ErrTooManyPieces
	}
	if len(pieces) == 0 {
		return &Plan{OrderID: job.OrderID, Feasible: true, Bounds: Bounds{0, 0}}, nil
	}
	s := &solver{
		job:      job,
		pieces:   pieces,
		maxBars:  maxBars,
		invUsed:  make([]bool, len(job.Inventory)),
		typeLeft: make([]int, len(job.StockTypes)),
	}
	// preallocate so append never reallocates mid-recursion
	s.slots = make([]slot, 0, maxBars)
	for i, t := range job.StockTypes {
		n := t.Max
		if n == 0 || n > maxBars {
			n = maxBars
		}
		s.typeLeft[i] = n
	}
	s.search(0, 0)
	if !s.found {
		return nil, ErrInfeasible
	}
	plan := buildPlan(job, s.bestSlots, pieces)
	b := ComputeBounds(job)
	if b.Lower > plan.Totals.TotalCost {
		b.Lower = plan.Totals.TotalCost
	}
	if b.Upper < 0 || b.Upper < plan.Totals.TotalCost {
		b.Upper = plan.Totals.TotalCost
	}
	plan.Bounds = b
	return plan, nil
}

func (s *solver) search(idx, purchase int) {
	if s.found && purchase > s.bestPurch {
		return
	}
	if idx == len(s.pieces) {
		scrap := 0
		for _, sl := range s.slots {
			lo := sl.length - sl.used
			if lo > 0 && lo < s.job.ScrapThreshold {
				scrap += lo
			}
		}
		if !s.found || purchase < s.bestPurch || (purchase == s.bestPurch && scrap < s.bestScrap) {
			s.found = true
			s.bestPurch = purchase
			s.bestScrap = scrap
			s.bestSlots = make([]slot, len(s.slots))
			for i, sl := range s.slots {
				cp := sl
				cp.labels = append([]string(nil), sl.labels...)
				s.bestSlots[i] = cp
			}
		}
		return
	}
	p := s.pieces[idx]
	need := p.length + s.job.Kerf
	// place into an existing open bar; identical states tried once
	seen := make(map[[2]int]bool)
	for i := 0; i < len(s.slots); i++ {
		if s.slots[i].used+need > s.slots[i].length {
			continue
		}
		key := [2]int{s.slots[i].length, s.slots[i].used}
		if seen[key] {
			continue
		}
		seen[key] = true
		s.slots[i].used += need
		s.slots[i].count++
		s.slots[i].labels = append(s.slots[i].labels, p.label)
		s.search(idx+1, purchase)
		s.slots[i].labels = s.slots[i].labels[:len(s.slots[i].labels)-1]
		s.slots[i].count--
		s.slots[i].used -= need
	}
	// open a new bar
	if len(s.slots) < s.maxBars && need <= maxAvailableLen(s.job, s.invUsed, s.typeLeft) {
		seenLen := make(map[int]bool)
		for i, b := range s.job.Inventory {
			if s.invUsed[i] || b.Length < need || seenLen[b.Length] {
				continue
			}
			seenLen[b.Length] = true
			s.invUsed[i] = true
			s.slots = append(s.slots, slot{length: b.Length, kind: 0, refIdx: i, used: need, count: 1, labels: []string{p.label}})
			s.search(idx+1, purchase)
			s.slots = s.slots[:len(s.slots)-1]
			s.invUsed[i] = false
		}
		for ti, t := range s.job.StockTypes {
			if s.typeLeft[ti] == 0 || t.Length < need {
				continue
			}
			if s.found && purchase+t.Cost > s.bestPurch {
				continue
			}
			s.typeLeft[ti]--
			s.slots = append(s.slots, slot{length: t.Length, cost: t.Cost, kind: 1, refIdx: ti, used: need, count: 1, labels: []string{p.label}})
			s.search(idx+1, purchase+t.Cost)
			s.slots = s.slots[:len(s.slots)-1]
			s.typeLeft[ti]++
		}
	}
}

func maxAvailableLen(job Job, invUsed []bool, typeLeft []int) int {
	m := 0
	for i, b := range job.Inventory {
		if !invUsed[i] && b.Length > m {
			m = b.Length
		}
	}
	for i, t := range job.StockTypes {
		if typeLeft[i] > 0 && t.Length > m {
			m = t.Length
		}
	}
	return m
}

func leftoverState(leftover, threshold int) string {
	switch {
	case leftover == 0:
		return "none"
	case leftover < threshold:
		return "scrap"
	default:
		return "reusable"
	}
}

func buildPlan(job Job, slots []slot, pieces []piece) *Plan {
	plan := &Plan{OrderID: job.OrderID, Feasible: true}
	known := map[string]Bar{}
	for _, b := range job.History {
		known[b.ID] = b
	}
	for _, b := range job.Inventory {
		known[b.ID] = b
	}
	pieceLen := map[string]int{}
	for _, p := range pieces {
		pieceLen[p.label] = p.length
	}
	purchSeq := 0
	var totals Totals
	for _, sl := range slots {
		var bp BarPlan
		bp.Length = sl.length
		bp.Cost = sl.cost
		bp.Cuts = append([]string(nil), sl.labels...)
		bp.CutCount = sl.count
		bp.KerfLoss = sl.count * job.Kerf
		bp.Leftover = sl.length - sl.used
		bp.LeftoverState = leftoverState(bp.Leftover, job.ScrapThreshold)
		if sl.kind == 0 {
			src := job.Inventory[sl.refIdx]
			bp.BarID = src.ID
			bp.Origin = "inventory"
		} else {
			purchSeq++
			bp.BarID = fmt.Sprintf("%s-P%d", job.OrderID, purchSeq)
			bp.Origin = "purchased"
			known[bp.BarID] = Bar{ID: bp.BarID, Length: sl.length, Origin: "purchased", Order: job.OrderID}
		}
		if bp.LeftoverState == "reusable" {
			lb := Bar{
				ID:       bp.BarID + "-L",
				Length:   bp.Leftover,
				ParentID: bp.BarID,
				Origin:   "leftover",
				Order:    job.OrderID,
			}
			bp.LeftoverID = lb.ID
			plan.NewInventory = append(plan.NewInventory, lb)
			known[lb.ID] = lb
		}
		plan.Bars = append(plan.Bars, bp)
		totals.PurchaseCost += sl.cost
		totals.CutCount += sl.count
		totals.KerfLoss += bp.KerfLoss
		totals.StockLength += sl.length
		switch bp.LeftoverState {
		case "scrap":
			totals.Scrap += bp.Leftover
		case "reusable":
			totals.Reusable += bp.Leftover
		}
	}
	for i, sl := range slots {
		barID := plan.Bars[i].BarID
		for _, label := range sl.labels {
			plan.Pieces = append(plan.Pieces, PiecePlacement{
				Label:  label,
				Length: pieceLen[label],
				BarID:  barID,
				Source: lineage(known, barID),
			})
			totals.PiecesLength += pieceLen[label]
		}
	}
	totals.CutCost = totals.CutCount * job.CutCost
	totals.TotalCost = totals.PurchaseCost + totals.CutCost
	totals.ConservationOK = totals.StockLength == totals.PiecesLength+totals.KerfLoss+totals.Scrap+totals.Reusable
	plan.Totals = totals
	return plan
}

// lineage renders the source tree of a bar as a chain back to its
// root purchased bar, e.g. "O2-P1-L <- O2-P1".
func lineage(known map[string]Bar, barID string) string {
	out := barID
	cur := barID
	for i := 0; i < 32; i++ {
		b, ok := known[cur]
		if !ok || b.ParentID == "" {
			break
		}
		cur = b.ParentID
		out += " <- " + cur
	}
	return out
}
