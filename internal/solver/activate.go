package solver

import (
	"errors"
	"fmt"
	"sort"
)

// maxActStates bounds the memoized search effort of SolveActivate.
const maxActStates = 4_000_000

// maxBruteWork bounds the exhaustive work of BruteForceActivate: it estimates
// (travelDays+1)^tickets, i.e. purchase subsets times activation-day tuples.
const maxBruteWork = 3_000_000

// ActTicket is activated by its first ride (ride-order triggered activation),
// stays valid for Validity days counting from the activation day, and can be
// used on at most Cap travel days within that window.
type ActTicket struct {
	ID       string
	Cost     int
	Validity int
	Cap      int
}

// Purchase certifies one bought ticket: when it activates and which travel
// days it is used on.
type Purchase struct {
	ID            string `json:"id"`
	ActivationDay int    `json:"activationDay"`
	UsedDays      []int  `json:"usedDays"`
}

// DayUse certifies which ticket is used on one travel day.
type DayUse struct {
	Day      int    `json:"day"`
	TicketID string `json:"ticketId"`
}

// ActSolution is the optimal joint purchase and activation plan together with
// its day-by-day usage certificate.
type ActSolution struct {
	Cost      int        `json:"cost"`
	Count     int        `json:"count"`
	IDs       []string   `json:"ticketIds"`
	Purchases []Purchase `json:"purchases"`
	Daily     []DayUse   `json:"daily"`
}

// ErrTooLarge is returned by the brute-force verifier when the instance
// exceeds the exhaustive search budget.
var ErrTooLarge = errors.New("instance too large for brute-force verification")

// validateActInput checks constraints and returns sorted unique travel days.
func validateActInput(days []int, tickets []ActTicket) ([]int, error) {
	travel, err := normalizeDays(days)
	if err != nil {
		return nil, err
	}
	if len(tickets) > MaxTickets {
		return nil, fmt.Errorf("too many ticket types: %d > %d", len(tickets), MaxTickets)
	}
	seen := map[string]bool{}
	for _, t := range tickets {
		if t.ID == "" {
			return nil, errors.New("ticket with empty id")
		}
		if seen[t.ID] {
			return nil, fmt.Errorf("duplicate ticket id %q", t.ID)
		}
		seen[t.ID] = true
		if t.Cost < 0 {
			return nil, fmt.Errorf("ticket %q has negative cost %d", t.ID, t.Cost)
		}
		if t.Validity < 1 {
			return nil, fmt.Errorf("ticket %q has validity %d < 1", t.ID, t.Validity)
		}
		if t.Cap < 1 {
			return nil, fmt.Errorf("ticket %q has cap %d < 1", t.ID, t.Cap)
		}
	}
	return travel, nil
}

// actKey is the memoization state: the day index plus, per ticket, the packed
// (expiry, remaining uses) pair; zero means the ticket has not been activated.
type actKey struct {
	day int
	st  [MaxTickets]uint64
}

func packState(expiry, remaining int) uint64 {
	return uint64(expiry)<<32 | uint64(uint32(remaining))
}

func unpackState(v uint64) (expiry, remaining int) {
	return int(v >> 32), int(uint32(v))
}

// actPartial is the optimal suffix plan from a search state.
type actPartial struct {
	cost   int
	count  int
	ids    []string // sorted ids of tickets activated in the suffix
	assign []int    // ticket index used on each remaining travel day
}

// SolveActivate finds the optimal joint purchase and activation plan via
// depth-first search over travel days with memoization. A ticket activates on
// the first day it is used; it may then be used on days d with
// activation <= d <= activation+Validity-1, at most Cap times.
func SolveActivate(days []int, tickets []ActTicket) (*ActSolution, error) {
	travel, err := validateActInput(days, tickets)
	if err != nil {
		return nil, err
	}
	if len(travel) == 0 {
		return &ActSolution{IDs: []string{}, Purchases: []Purchase{}, Daily: []DayUse{}}, nil
	}
	n := len(tickets)
	memo := make(map[actKey]*actPartial)
	overflow := false

	var dfs func(i int, st *[MaxTickets]uint64) *actPartial
	dfs = func(i int, st *[MaxTickets]uint64) *actPartial {
		if i == len(travel) {
			return &actPartial{ids: []string{}, assign: []int{}}
		}
		key := actKey{day: i, st: *st}
		if p, ok := memo[key]; ok {
			return p
		}
		if len(memo) >= maxActStates {
			overflow = true
			return nil
		}
		d := travel[i]
		var best *actPartial
		for t := 0; t < n; t++ {
			expiry, rem := unpackState(st[t])
			var next [MaxTickets]uint64
			var addCost, addCount int
			var addID string
			switch {
			case expiry == 0:
				// Fresh ticket: using it today activates it.
				next = *st
				next[t] = packState(d+tickets[t].Validity-1, tickets[t].Cap-1)
				addCost, addCount, addID = tickets[t].Cost, 1, tickets[t].ID
			case d <= expiry && rem > 0:
				next = *st
				next[t] = packState(expiry, rem-1)
			default:
				continue
			}
			sub := dfs(i+1, &next)
			if overflow {
				return nil
			}
			if sub == nil {
				continue
			}
			cand := &actPartial{
				cost:   addCost + sub.cost,
				count:  addCount + sub.count,
				assign: make([]int, 0, len(sub.assign)+1),
			}
			if addCount > 0 {
				cand.ids = insertSorted(sub.ids, addID)
			} else {
				cand.ids = sub.ids
			}
			cand.assign = append(cand.assign, t)
			cand.assign = append(cand.assign, sub.assign...)
			if best == nil || betterTriple(cand.cost, cand.count, cand.ids, best.cost, best.count, best.ids) {
				best = cand
			}
		}
		memo[key] = best
		return best
	}

	var st [MaxTickets]uint64
	root := dfs(0, &st)
	if overflow {
		return nil, errors.New("search space too large")
	}
	if root == nil {
		return nil, ErrInfeasible
	}
	return buildActSolution(travel, tickets, root), nil
}

// buildActSolution turns the per-day ticket assignment into purchases and the
// day-by-day usage certificate.
func buildActSolution(travel []int, tickets []ActTicket, p *actPartial) *ActSolution {
	used := map[int][]int{}
	for i, t := range p.assign {
		used[t] = append(used[t], travel[i])
	}
	purchases := make([]Purchase, 0, len(used))
	for t, ds := range used {
		sort.Ints(ds)
		purchases = append(purchases, Purchase{ID: tickets[t].ID, ActivationDay: ds[0], UsedDays: ds})
	}
	sort.Slice(purchases, func(a, b int) bool { return purchases[a].ID < purchases[b].ID })
	daily := make([]DayUse, len(travel))
	for i, t := range p.assign {
		daily[i] = DayUse{Day: travel[i], TicketID: tickets[t].ID}
	}
	return &ActSolution{
		Cost:      p.cost,
		Count:     p.count,
		IDs:       p.ids,
		Purchases: purchases,
		Daily:     daily,
	}
}

// CheckActCertificate validates a day-by-day usage certificate without
// re-solving: every travel day is used exactly once, every used ticket is
// purchased, and each purchase respects its activation day, validity window
// and coverage cap.
func CheckActCertificate(days []int, tickets []ActTicket, sol *ActSolution) error {
	if sol == nil {
		return errors.New("nil solution")
	}
	travel, err := validateActInput(days, tickets)
	if err != nil {
		return err
	}
	byID := make(map[string]ActTicket, len(tickets))
	for _, t := range tickets {
		byID[t.ID] = t
	}
	purchased := make(map[string]Purchase, len(sol.Purchases))
	cost := 0
	for _, p := range sol.Purchases {
		if _, ok := byID[p.ID]; !ok {
			return fmt.Errorf("certificate purchases unknown ticket %q", p.ID)
		}
		if _, dup := purchased[p.ID]; dup {
			return fmt.Errorf("ticket %q purchased more than once", p.ID)
		}
		purchased[p.ID] = p
		cost += byID[p.ID].Cost
	}
	if cost != sol.Cost {
		return fmt.Errorf("certificate cost %d does not match purchase sum %d", sol.Cost, cost)
	}
	if len(sol.Purchases) != sol.Count {
		return fmt.Errorf("certificate count %d does not match %d purchases", sol.Count, len(sol.Purchases))
	}
	usedBy := make(map[string][]int)
	seenDay := make(map[int]bool, len(sol.Daily))
	for _, u := range sol.Daily {
		if seenDay[u.Day] {
			return fmt.Errorf("day %d used twice", u.Day)
		}
		seenDay[u.Day] = true
		if _, ok := purchased[u.TicketID]; !ok {
			return fmt.Errorf("day %d uses unpurchased ticket %q", u.Day, u.TicketID)
		}
		usedBy[u.TicketID] = append(usedBy[u.TicketID], u.Day)
	}
	for _, d := range travel {
		if !seenDay[d] {
			return fmt.Errorf("day %d is not covered by the certificate", d)
		}
	}
	for id, p := range purchased {
		t := byID[id]
		got := append([]int(nil), usedBy[id]...)
		sort.Ints(got)
		want := append([]int(nil), p.UsedDays...)
		sort.Ints(want)
		if len(got) != len(want) {
			return fmt.Errorf("ticket %q used days %v do not match purchase %v", id, got, want)
		}
		for i := range got {
			if got[i] != want[i] {
				return fmt.Errorf("ticket %q used days %v do not match purchase %v", id, got, want)
			}
		}
		if len(want) == 0 {
			return fmt.Errorf("ticket %q purchased but never used", id)
		}
		if p.ActivationDay != want[0] {
			return fmt.Errorf("ticket %q activates on day %d but first use is day %d", id, p.ActivationDay, want[0])
		}
		if last := want[len(want)-1]; last > p.ActivationDay+t.Validity-1 {
			return fmt.Errorf("ticket %q used on day %d beyond validity window ending day %d", id, last, p.ActivationDay+t.Validity-1)
		}
		if len(want) > t.Cap {
			return fmt.Errorf("ticket %q used %d days, exceeding cap %d", id, len(want), t.Cap)
		}
	}
	return nil
}

// BruteForceActivate independently enumerates every purchase subset and every
// activation-day tuple (activation days are travel days), checks feasibility
// by assigning travel days to active tickets, and returns the optimum. It is
// the short-trip verifier for SolveActivate.
func BruteForceActivate(days []int, tickets []ActTicket) (*ActSolution, error) {
	travel, err := validateActInput(days, tickets)
	if err != nil {
		return nil, err
	}
	if len(travel) == 0 {
		return &ActSolution{IDs: []string{}, Purchases: []Purchase{}, Daily: []DayUse{}}, nil
	}
	n := len(tickets)
	// Work estimate: sum over subsets of D^|S| = (D+1)^n.
	work := 1
	for i := 0; i < n; i++ {
		work *= len(travel) + 1
		if work > maxBruteWork {
			return nil, ErrTooLarge
		}
	}

	found := false
	bestCost, bestCount := 0, 0
	var bestIDs []string
	var bestAssign []int

	// Feasibility of one (subset, activation days) combination: assign every
	// travel day to a ticket whose window covers it, respecting caps.
	var tryAssign func(sub []int, acts []int) []int
	tryAssign = func(sub []int, acts []int) []int {
		used := make([]int, len(sub))
		assign := make([]int, len(travel))
		var rec func(i int) bool
		rec = func(i int) bool {
			if i == len(travel) {
				return true
			}
			d := travel[i]
			for s, t := range sub {
				if used[s] >= tickets[t].Cap {
					continue
				}
				actDay := travel[acts[s]]
				if d < actDay || d > actDay+tickets[t].Validity-1 {
					continue
				}
				used[s]++
				assign[i] = t
				if rec(i + 1) {
					return true
				}
				used[s]--
			}
			return false
		}
		if rec(0) {
			return assign
		}
		return nil
	}

	for subset := uint32(1); subset < uint32(1)<<uint(n); subset++ {
		var sub []int
		cost := 0
		var ids []string
		for t := 0; t < n; t++ {
			if subset>>uint(t)&1 == 1 {
				sub = append(sub, t)
				cost += tickets[t].Cost
				ids = insertSorted(ids, tickets[t].ID)
			}
		}
		if found && cost > bestCost {
			continue
		}
		// Enumerate activation-day tuples over the travel days.
		acts := make([]int, len(sub))
		for {
			if assign := tryAssign(sub, acts); assign != nil {
				count := len(sub)
				if !found || betterTriple(cost, count, ids, bestCost, bestCount, bestIDs) {
					found = true
					bestCost, bestCount, bestIDs = cost, count, ids
					bestAssign = assign
				}
				break // activation days do not affect the objective
			}
			pos := len(acts) - 1
			for pos >= 0 {
				acts[pos]++
				if acts[pos] < len(travel) {
					break
				}
				acts[pos] = 0
				pos--
			}
			if pos < 0 {
				break
			}
		}
	}
	if !found {
		return nil, ErrInfeasible
	}
	return buildActSolution(travel, tickets, &actPartial{
		cost: bestCost, count: bestCount, ids: bestIDs, assign: bestAssign,
	}), nil
}
