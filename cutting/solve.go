package cutting

import (
	"errors"
	"fmt"
	"sort"
)

// ErrInfeasible is returned when no plan can satisfy the demand within the
// bar/piece limits.
var ErrInfeasible = errors.New("cutting: no feasible plan")

// maxExactPieces caps the exact branch-and-bound solver.
const maxExactPieces = 64

// costKey is the lexicographic objective: purchase money first, then scrap
// length, then cut money.
type costKey struct {
	purchase int
	scrap    int
	cutMoney int
}

func (a costKey) less(b costKey) bool {
	if a.purchase != b.purchase {
		return a.purchase < b.purchase
	}
	if a.scrap != b.scrap {
		return a.scrap < b.scrap
	}
	return a.cutMoney < b.cutMoney
}

func (a costKey) add(b costKey) costKey {
	return costKey{a.purchase + b.purchase, a.scrap + b.scrap, a.cutMoney + b.cutMoney}
}

type piece struct {
	id     string
	length int
}

// bin is a bar being filled during the search.
type bin struct {
	sum    int   // sum of piece lengths
	pieces []int // indices into solver.pieces
}

// fitResult describes how k pieces of total length sum fit a stock bar.
type fitResult struct {
	ok       bool
	cuts     int
	kerfLoss int
	leftover int
	remnant  int // kept leftover (>= minRemnant)
	scrap    int // leftover below minRemnant
}

// stockChoice is the stock assigned to one bin.
type stockChoice struct {
	isRemnant bool
	remIdx    int
	typeIdx   int
	stockLen  int
	cost      int
	fit       fitResult
}

type solver struct {
	kerf        int
	minRemnant  int
	cutCost     int
	maxPieces   int
	maxBars     int
	stockTypes  []StockType
	remnants    []Bar
	pieces      []piece // sorted by length descending
	maxStock    int
	maxTypeLen  int
	minTypeCost int
	hasTypes    bool
	// remnantCapacity is the total length of inventory remnants, used for
	// lower bounds (a relaxation: it may be counted against several bins).
	remnantCapacity int

	found       bool
	bestKey     costKey
	bestBins    []bin
	bestChoices []stockChoice
}

func newSolver(spec *Spec) (*solver, error) {
	if spec.Kerf < 0 || spec.MinRemnant < 0 || spec.CutCost < 0 {
		return nil, fmt.Errorf("cutting: kerf, minRemnant and cutCost must be >= 0")
	}
	s := &solver{
		kerf:       spec.Kerf,
		minRemnant: spec.MinRemnant,
		cutCost:    spec.CutCost,
		maxPieces:  spec.MaxPiecesPerBar,
		maxBars:    spec.MaxBars,
	}
	if s.maxPieces <= 0 {
		s.maxPieces = 16
	}
	if s.maxBars <= 0 {
		s.maxBars = 8
	}
	for _, t := range spec.StockTypes {
		if t.Length <= 0 || t.Cost < 0 {
			return nil, fmt.Errorf("cutting: invalid stock type %+v", t)
		}
		s.stockTypes = append(s.stockTypes, t)
		if t.Length > s.maxStock {
			s.maxStock = t.Length
		}
		if t.Length > s.maxTypeLen {
			s.maxTypeLen = t.Length
		}
		if !s.hasTypes || t.Cost < s.minTypeCost {
			s.minTypeCost = t.Cost
		}
		s.hasTypes = true
	}
	if len(spec.Remnants) > 63 {
		return nil, fmt.Errorf("cutting: at most 63 inventory remnants supported")
	}
	for _, r := range spec.Remnants {
		if r.Length <= 0 || r.ID == "" {
			return nil, fmt.Errorf("cutting: invalid remnant %+v", r)
		}
		s.remnants = append(s.remnants, r)
		if r.Length > s.maxStock {
			s.maxStock = r.Length
		}
		s.remnantCapacity += r.Length
	}
	n := 0
	for _, d := range spec.Demands {
		if d.Length <= 0 || d.Count < 0 {
			return nil, fmt.Errorf("cutting: invalid demand %+v", d)
		}
		n += d.Count
	}
	if n == 0 {
		return nil, fmt.Errorf("cutting: empty demand")
	}
	if n > maxExactPieces {
		return nil, fmt.Errorf("cutting: %d pieces exceeds exact-solver limit %d", n, maxExactPieces)
	}
	idx := 1
	for _, d := range spec.Demands {
		for i := 0; i < d.Count; i++ {
			s.pieces = append(s.pieces, piece{id: fmt.Sprintf("P%d", idx), length: d.Length})
			idx++
		}
	}
	sort.SliceStable(s.pieces, func(i, j int) bool {
		return s.pieces[i].length > s.pieces[j].length
	})
	for _, p := range s.pieces {
		if p.length > s.maxStock {
			return nil, fmt.Errorf("cutting: piece %s (len %d) longer than any stock", p.id, p.length)
		}
	}
	return s, nil
}

// fit computes the cut layout of k pieces (total length sum) on a stock bar.
// k pieces need k-1 cuts when they consume the bar exactly, otherwise k cuts
// (the last cut separates the final piece from the leftover). The leftover
// must be able to absorb the final cut's kerf.
func (s *solver) fit(sum, k, stockLen int) fitResult {
	if k <= 0 {
		return fitResult{ok: true}
	}
	base := sum + s.kerf*(k-1)
	var cuts int
	switch {
	case base == stockLen:
		cuts = k - 1
	case base+s.kerf <= stockLen:
		cuts = k
	default:
		return fitResult{}
	}
	kerfLoss := cuts * s.kerf
	leftover := stockLen - sum - kerfLoss
	remnant := 0
	if leftover >= s.minRemnant {
		remnant = leftover
	}
	return fitResult{ok: true, cuts: cuts, kerfLoss: kerfLoss, leftover: leftover, remnant: remnant, scrap: leftover - remnant}
}

// assign picks a stock (purchased type or inventory remnant) for every bin,
// minimizing the lexicographic costKey. Remnants are used at most once.
func (s *solver) assign(bins []bin) (costKey, []stockChoice, bool) {
	nb := len(bins)
	memo := make(map[[2]int]costKey)
	seen := make(map[[2]int]bool)
	choiceMemo := make(map[[2]int]stockChoice)
	var rec func(i int, mask uint64) (costKey, bool)
	rec = func(i int, mask uint64) (costKey, bool) {
		if i == nb {
			return costKey{}, true
		}
		mk := [2]int{i, int(mask)}
		if ok, hit := seen[mk]; hit {
			return memo[mk], ok
		}
		best := costKey{}
		found := false
		var bestChoice stockChoice
		consider := func(ch stockChoice, nmask uint64) {
			rest, ok := rec(i+1, nmask)
			if !ok {
				return
			}
			total := costKey{ch.cost, ch.fit.scrap, ch.fit.cuts * s.cutCost}.add(rest)
			if !found || total.less(best) {
				best, found, bestChoice = total, true, ch
			}
		}
		for ri, r := range s.remnants {
			if mask&(1<<uint(ri)) != 0 {
				continue
			}
			f := s.fit(bins[i].sum, len(bins[i].pieces), r.Length)
			if !f.ok {
				continue
			}
			consider(stockChoice{isRemnant: true, remIdx: ri, stockLen: r.Length, fit: f}, mask|(1<<uint(ri)))
		}
		for ti, t := range s.stockTypes {
			f := s.fit(bins[i].sum, len(bins[i].pieces), t.Length)
			if !f.ok {
				continue
			}
			consider(stockChoice{typeIdx: ti, stockLen: t.Length, cost: t.Cost, fit: f}, mask)
		}
		memo[mk] = best
		seen[mk] = found
		choiceMemo[mk] = bestChoice
		return best, found
	}
	key, ok := rec(0, 0)
	if !ok {
		return costKey{}, nil, false
	}
	choices := make([]stockChoice, nb)
	mask := uint64(0)
	for i := 0; i < nb; i++ {
		ch := choiceMemo[[2]int{i, int(mask)}]
		choices[i] = ch
		if ch.isRemnant {
			mask |= 1 << uint(ch.remIdx)
		}
	}
	return key, choices, true
}

// minCostFit is a relaxed (remnants may be double counted) lower bound on the
// purchase cost of a stock bar holding the given load.
func (s *solver) minCostFit(load int) int {
	for _, r := range s.remnants {
		if r.Length >= load {
			return 0
		}
	}
	best := -1
	for _, t := range s.stockTypes {
		if t.Length >= load && (best < 0 || t.Cost < best) {
			best = t.Cost
		}
	}
	if best < 0 {
		return 1 << 60
	}
	return best
}

// prune reports whether the partial solution cannot beat the incumbent on the
// primary objective (purchase cost).
func (s *solver) prune(bins []bin, idx int) bool {
	if !s.found {
		return false
	}
	lb := 0
	for _, b := range bins {
		load := b.sum + s.kerf*max(0, len(b.pieces)-1)
		lb += s.minCostFit(load)
	}
	rem := 0
	for i := idx; i < len(s.pieces); i++ {
		rem += s.pieces[i].length
	}
	// Remnants may cover part of the remaining demand for free (relaxation:
	// remnant capacity is not charged against any single bin).
	rem -= s.remnantCapacity
	if rem > 0 && s.maxTypeLen > 0 && s.hasTypes {
		lb += rem / s.maxTypeLen * s.minTypeCost
	}
	return lb > s.bestKey.purchase
}

func (s *solver) dfs(idx int, bins []bin) {
	if s.prune(bins, idx) {
		return
	}
	if idx == len(s.pieces) {
		key, choices, ok := s.assign(bins)
		if !ok {
			return
		}
		if !s.found || key.less(s.bestKey) {
			s.found = true
			s.bestKey = key
			s.bestBins = make([]bin, len(bins))
			for i := range bins {
				s.bestBins[i] = bin{sum: bins[i].sum, pieces: append([]int(nil), bins[i].pieces...)}
			}
			s.bestChoices = choices
		}
		return
	}
	p := s.pieces[idx]
	type seenKey struct{ sum, count int }
	seen := make(map[seenKey]bool)
	for i := range bins {
		k := len(bins[i].pieces)
		if k >= s.maxPieces {
			continue
		}
		newSum := bins[i].sum + p.length
		if newSum+s.kerf*k > s.maxStock {
			continue
		}
		sk := seenKey{bins[i].sum, k}
		if seen[sk] {
			continue
		}
		seen[sk] = true
		bins[i].pieces = append(bins[i].pieces, idx)
		bins[i].sum = newSum
		s.dfs(idx+1, bins)
		bins[i].pieces = bins[i].pieces[:k]
		bins[i].sum = newSum - p.length
	}
	if len(bins) < s.maxBars {
		bins = append(bins, bin{sum: p.length, pieces: []int{idx}})
		s.dfs(idx+1, bins)
		bins = bins[:len(bins)-1]
	}
}

// Solve computes an optimal cutting plan for the spec. The objective is
// lexicographic: purchase cost, then scrap length, then cut cost.
func Solve(spec *Spec) (*Plan, error) {
	s, err := newSolver(spec)
	if err != nil {
		return nil, err
	}
	s.dfs(0, nil)
	if !s.found {
		return nil, ErrInfeasible
	}
	return s.buildPlan(spec), nil
}

func (s *solver) buildPlan(spec *Spec) *Plan {
	plan := &Plan{OrderID: spec.OrderID}
	prefix := spec.RemnantPrefix
	if prefix == "" {
		prefix = "R"
	}
	nextRem := spec.NextRemnantNum
	if nextRem <= 0 {
		nextRem = 1
	}
	newBarNum := 1
	for bi, b := range s.bestBins {
		ch := s.bestChoices[bi]
		bp := BarPlan{
			StockLength: ch.stockLen,
			Cuts:        ch.fit.cuts,
			KerfLoss:    ch.fit.kerfLoss,
			Remnant:     ch.fit.remnant,
			Scrap:       ch.fit.scrap,
		}
		if ch.isRemnant {
			r := s.remnants[ch.remIdx]
			bp.BarID = r.ID
			bp.Source = r.Source
			if bp.Source == "" {
				bp.Source = "inventory remnant"
			}
			plan.UsedRemnantIDs = append(plan.UsedRemnantIDs, r.ID)
		} else {
			t := s.stockTypes[ch.typeIdx]
			bp.BarID = fmt.Sprintf("NEW-%d", newBarNum)
			newBarNum++
			bp.Purchased = true
			bp.PurchaseCost = t.Cost
			bp.Source = fmt.Sprintf("purchased (len %d, cost %d)", t.Length, t.Cost)
		}
		order := append([]int(nil), b.pieces...)
		sort.Slice(order, func(i, j int) bool {
			pi, pj := s.pieces[order[i]], s.pieces[order[j]]
			if pi.length != pj.length {
				return pi.length > pj.length
			}
			return pi.id < pj.id
		})
		for _, pi := range order {
			bp.Pieces = append(bp.Pieces, PlacedPiece{ID: s.pieces[pi].id, Length: s.pieces[pi].length})
		}
		if bp.Remnant > 0 {
			bp.RemnantID = fmt.Sprintf("%s%04d", prefix, nextRem)
			nextRem++
			plan.NewRemnants = append(plan.NewRemnants, Bar{
				ID:     bp.RemnantID,
				Length: bp.Remnant,
				Source: fmt.Sprintf("remnant of %s (order %s)", bp.BarID, spec.OrderID),
			})
		}
		plan.Bars = append(plan.Bars, bp)
	}
	for _, b := range plan.Bars {
		for _, p := range b.Pieces {
			plan.TotalPieces++
			plan.DemandLength += p.Length
		}
		plan.TotalStockLength += b.StockLength
		plan.TotalKerfLoss += b.KerfLoss
		plan.TotalRemnant += b.Remnant
		plan.TotalScrap += b.Scrap
		plan.TotalCuts += b.Cuts
		plan.PurchaseCost += b.PurchaseCost
	}
	plan.CutCostTotal = plan.TotalCuts * s.cutCost
	plan.Budget = plan.PurchaseCost + plan.CutCostTotal
	plan.Bounds = s.bounds(plan)
	plan.ConservationOK = plan.CheckConservation()
	return plan
}

// bounds computes lower/upper bounds for the order budget. Purchase lower
// bound: ceil(demand/maxStock) bars at the cheapest type price (kerf ignored,
// a relaxation). Cuts lower bound: each bar saves at most one cut.
func (s *solver) bounds(p *Plan) Bounds {
	n := len(s.pieces)
	total := 0
	for _, pc := range s.pieces {
		total += pc.length
	}
	// Purchased bars must cover the demand length that remnants cannot
	// (relaxation: kerf and binning losses ignored).
	purchaseLB := 0
	if remLen := total - s.remnantCapacity; remLen > 0 && s.hasTypes && s.maxTypeLen > 0 {
		purchaseLB = (remLen + s.maxTypeLen - 1) / s.maxTypeLen * s.minTypeCost
	}
	saved := min(n, s.maxBars)
	cutsLB := n - saved
	return Bounds{
		PurchaseLower: purchaseLB,
		PurchaseUpper: p.PurchaseCost,
		CutsLower:     cutsLB,
		CutsUpper:     p.TotalCuts,
		BudgetLower:   purchaseLB + cutsLB*s.cutCost,
		BudgetUpper:   p.Budget,
	}
}

// Tuple exposes the objective tuple (purchase, scrap, cut money) for
// verification against an externally computed plan.
func (k costKey) Tuple() [3]int { return [3]int{k.purchase, k.scrap, k.cutMoney} }

// Objective returns the objective tuple (purchase, scrap, cut money) of a
// finished plan.
func Objective(p *Plan) [3]int { return [3]int{p.PurchaseCost, p.TotalScrap, p.CutCostTotal} }
